'use strict';

const fs = require('fs-extra');
const path = require('path');
const time = require('../time');
const uuid = require('uuid');
const client = require('../client');
const debug = require('debug');
const trigger = require('../../lib/trigger');
const promiseRetry = require('../retry');

const { getProfile } = require('../profile');
const { green, red, yellow } = require('colors');
const { promptForConfirmContinue } = require('../init/prompt');
const { zipCodeToOss } = require('../package/template');
const { processOSSBucket } = require('../package/package');
const { outputTemplateFile } = require('../import/utils');
const fc = require('../fc');

const log = require('single-line-log').stdout;
const Table = require('cli-table3');

const _ = require('lodash');

const DEFAULT_ROS_TIMEOUT_IN_MINS = 10;
const requestOption = {
  method: 'POST'
};

const DELETE_LAST_DEPLOYMENT_FAILED_STATUS = ['CREATE_ROLLBACK_COMPLETE', 'CREATE_FAILED'];

const ROS_STATUS_COMPLETE = ['CREATE_COMPLETE', 'UPDATE_COMPLETE'];

const ROS_STATUS_FOR_DELETE_CHANGESET = ['CREATE_COMPLETE', 'CREATE_FAILED', 'DELETE_FAILED'];

const ROS_EXECUTE_STATUS_FOR_DELETE_CHANGESET = ['UNAVAILABLE', 'AVAILABLE'];

const ROS_STATUS_PROGRESS = ['CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS', 'DELETE_IN_PROGRESS', 'CHECK_IN_PROGRESS'];

const ROS_STATUS_FAILED = ['UPDATE_FAILED', 'CREATE_FAILED', 'DELETE_FAILED', 'ROLLBACK_FAILED', 'CHECK_FAILED'];

const ROS_RESOURCE_TYPE = 'ALIYUN::ROS::Stack';

const tableHeads = ['LogicalResourceId', 'ResourceType', 'Action', 'Property'];

const eventTableHeads = ['LogicalResourceId', 'Status'];

const outputsTableHeads = ['OutputKey', 'OutputValue', 'Description'];

const parametersTableHeads = ['ParameterKey', 'ParameterValue'];

const ROS_TEMPLATE_PATH = path.join('.fun', 'tmp', 'rosTemplate.json');

async function findRosStack(rosClient, region, stackName) {
  const pageSize = 50;
  let requestPageNumber = 0;
  let totalCount;
  let pageNumber;

  let stack;

  do {
    const params = {
      'RegionId': region,
      'StackName.1': stackName,
      'PageSize': pageSize,
      'PageNumber': ++requestPageNumber,
      'ShowNestedStack': false
    };

    const rs = await rosClient.request('ListStacks', params, requestOption);

    totalCount = rs.TotalCount;
    pageNumber = rs.PageNumber;

    const stacks = rs.Stacks;

    stack = _.find(stacks, { StackName: stackName });
  } while (!stack && totalCount && pageNumber && pageNumber * pageSize < totalCount);

  const curStack = (stack || {});
  return {
    stackId: curStack.StackId,
    stackStatus: curStack.Status
  };
}

function generateChangeSetName() {
  return 'fun-' + uuid.v4();
}

async function updateChangeSet(rosClient, region, stackName, stackId, tpl, parameters = {}) {
  try {
    const params = {
      'RegionId': region,
      'ChangeSetName': generateChangeSetName(),
      'StackId': stackId,
      'ChangeSetType': 'UPDATE',
      'Description': 'generated by Funcraft',
      'TemplateBody': JSON.stringify(tpl),
      'DisableRollback': false,
      'TimeoutInMinutes': DEFAULT_ROS_TIMEOUT_IN_MINS,
      'UsePreviousParameters': true
    };

    Object.assign(params, parameters);

    debug('update stacks, params %s', params);

    const res = await rosClient.request('CreateChangeSet', params, requestOption);
    return res.ChangeSetId;
  } catch (e) {
    if (e.name === 'NotSupportedError' && e.data && e.data.Message && e.data.Message.indexOf('Update the completely same stack') !== -1) {
      throw new Error(red(`no need to update, your stack ${stackName} is already latest`)); // todo: 
    } else {
      throw e;
    }
  }
}

async function createChangeSet(rosClient, region, stackName, tpl, parameters = {}) {
  const params = {
    'RegionId': region,
    'ChangeSetName': generateChangeSetName(),
    'StackName': stackName,
    'ChangeSetType': 'CREATE',
    'Description': 'generated by Funcraft',
    'TemplateBody': JSON.stringify(tpl),
    'DisableRollback': true,
    'TimeoutInMinutes': DEFAULT_ROS_TIMEOUT_IN_MINS
  };

  Object.assign(params, parameters);

  debug('create stacks, params %s', params);

  const res = await rosClient.request('CreateChangeSet', params, requestOption);
  return {
    'changeSetId': res.ChangeSetId,
    'stackId': res.StackId
  };
}

async function execChangeSet(rosClient, region, changeSetId) {
  const params = {
    'RegionId': region,
    'ChangeSetId': changeSetId
  };

  await rosClient.request('ExecuteChangeSet', params, requestOption);
}

async function getChangeSet(rosClient, changeSetId, region) {

  let res;
  let changes;
  do {
    const params = {
      'RegionId': region,
      'ChangeSetId': changeSetId,
      'ShowTemplate': true
    };

    await time.sleep(500);

    res = await rosClient.request('GetChangeSet', params, requestOption);

    changes = res.Changes;
  } while (!changes);

  return {
    changes,
    parameters: res.Parameters,
    status: res.Status,
    executionStatus: res.ExecutionStatus
  };
}

// ┌────────────────┬──────────────────────┬────────┬─────────────┐
// │ Id             │ ResourceType         │ Action │ Propertity  │
// ├────────────────┼──────────────────────┼────────┼─────────────┤
// │ RosDemo        │ ALIYUN::FC::Service  │ Modify │ Description │
// ├────────────────┼──────────────────────┼────────┼─────────────┤
// │                │                      │        │ Code        │
// │                │                      │        ├─────────────┤
// │ RosDemoRosDemo │ ALIYUN::FC::Function │ Modify │ Timeout     │
// │                │                      │        ├─────────────┤
// │                │                      │        │ Runtime     │
// └────────────────┴──────────────────────┴────────┴─────────────┘

function displayChanges(changes) {
  if (_.isEmpty(changes)) { return; }
  console.log(`\nROS ChangeSet Changes:\n`);

  const table = getTableInstance(tableHeads);

  const map = new Map();

  _.forEach(changes, change => {
    // key: [LogicalResourceId, ResourceType, Action]
    // value: [Name1, Name2.....]
    const logicalResourceId = change.ResourceChange.LogicalResourceId;
    const resourceType = change.ResourceChange.ResourceType;
    const action = change.ResourceChange.Action;

    const key = [logicalResourceId, resourceType, action];
    const value = change.ResourceChange.Details.map(detail => detail.Target.Name);
    map.set(key, value);
  });

  for (let [key, value] of map.entries()) {

    const valueSize = value.length;

    const line = [
      {rowSpan: valueSize, content: key[0], vAlign: 'center'},
      {rowSpan: valueSize, content: key[1], vAlign: 'center'},
      {rowSpan: valueSize, content: key[2], vAlign: 'center'}
    ];

    if (_.isEmpty(value)) {

      line.push('');
      table.push(line);
    } else {
      let first = true;

      for (const pro of value) {
        if (first) {
          line.push(pro);
          table.push(line);
          first = false;
        } else {
          table.push([pro]);
        }
      }
    }
  }
  console.log(table.toString());
  console.log();
}

async function getStackEvents(rosClient, stackId, region, stackName) {

  let isComplete = false;

  const pageSize = 50;
  let requestPageNumber = 1;
  let totalCount;
  let pageNumber;

  let leftPageCollect = [];

  do {

    const params = {
      'StackId': stackId,
      'RegionId': region,
      'PageSize': pageSize,
      'PageNumber': requestPageNumber
    };

    await time.sleep(2000);

    const rs = await rosClient.request('ListStackEvents', params, requestOption);

    const events = rs.Events;

    totalCount = rs.TotalCount;
    pageNumber = rs.PageNumber;

    const index = _.findIndex(events, event => {

      return event.ResourceType === ROS_RESOURCE_TYPE && _.includes(ROS_STATUS_PROGRESS, event.Status);
    });

    // 0: find it but not begin
    if (index === 0 && requestPageNumber === 1) {
      return {
        isComplete: false,
        events: []
      };
    }

    // -1: not find
    if (index === -1) {

      leftPageCollect = _.concat(leftPageCollect, events);
      requestPageNumber++;
      continue;
    }

    const concatEvents = _.concat(leftPageCollect, events);

    let sliceEvents;

    if (requestPageNumber > 1) {

      sliceEvents = _.slice(concatEvents, 0, (requestPageNumber - 1) * pageSize + events.length - 1);

    } else {

      sliceEvents = _.slice(concatEvents, 0, index);
    }

    sliceEvents.forEach(e => {
      if (_.includes(ROS_STATUS_FAILED, e.Status)) {

        console.error(red(e.StatusReason));

        const url = `https://ros.console.aliyun.com/#/stack/${region}`;
        throw new Error(`\nDeploy failed, you can login to ${url} to see deploy logs.\n`);
      }
    });

    const complete = sliceEvents.filter(s => {
      return _.includes(ROS_STATUS_COMPLETE, s.Status);
    });

    const firstEvent = _.first(sliceEvents);

    isComplete = firstEvent.ResourceType === ROS_RESOURCE_TYPE && _.includes(ROS_STATUS_COMPLETE, firstEvent.Status);

    if (isComplete) {

      _.remove(complete, e => {

        return e.LogicalResourceId === stackName;
      });

      return {
        completed: isComplete,
        events: complete
      };
    }

    const logicalResourceIds = complete.map(c => c.LogicalResourceId);

    _.remove(sliceEvents, e => {

      return _.includes(logicalResourceIds, e.LogicalResourceId) && !_.includes(ROS_STATUS_COMPLETE, e.Status);
    });

    return {
      completed: isComplete,
      events: sliceEvents
    };

  } while (!isComplete && totalCount && pageNumber && pageNumber * pageSize < totalCount);
}

async function getTemplate(rosClient, stackId, region) {

  const params = {
    'RegionId': region,
    'StackId': stackId
  };

  debug('get template, params %s', params);

  const res = await rosClient.request('GetTemplate', params, requestOption);

  return res.TemplateBody;
}

// ┌─────────────────────────┬────────────────────┐
// │ LogicalResourceId       │ Status             │
// ├─────────────────────────┼────────────────────┤
// │ cdn-test-servicecdn-te… │ CREATE_COMPLETE    │
// ├─────────────────────────┼────────────────────┤
// │ cdn-test-servicecdn-te… │ CREATE_COMPLETE    │
// ├─────────────────────────┼────────────────────┤
// │ cdn-test-servicecdn-te… │ CREATE_COMPLETE    │
// ├─────────────────────────┼────────────────────┤
// │ cdn-test-service        │ CREATE_COMPLETE    │
// └─────────────────────────┴────────────────────┘

function displayEventsStatus(events, stackName) {

  const table = new Table({
    head: eventTableHeads,
    style: {
      head: ['green'],
      border: []
    },
    colWidths: [30, 20] //set the widths of each column (optional)
  });

  events.filter(f => f.LogicalResourceId !== stackName)
    .forEach(e => {
      table.push([e.LogicalResourceId, e.Status]);
    });

  log(table.toString() + '\n');
}

async function displayOutputs(outputs) {

  if (_.isEmpty(outputs)) { return ; }

  console.log('ROS Stack Outputs:\n');

  const table = getTableInstance(outputsTableHeads);

  _.forEach(outputs, p => {

    table.push([p.OutputKey, p.OutputValue, p.Description]);
  });

  console.log(table.toString() + '\n');
}

function findRealFunction(rosResources, rosFunctionName) {
  const rosFunctionRes = rosResources[rosFunctionName];

  if (rosFunctionRes && rosFunctionRes.Type === 'ALIYUN::FC::Function') {

    const prop = rosFunctionRes.Properties;

    return {
      realServiceName: prop.ServiceName,
      realFunctionName: prop.FunctionName
    };
  }
  return {};
}

function generateUri(path, domainName) {
  const uri = domainName + path;

  if (_.endsWith(uri, '/')) {
    return _.trimEnd(uri, '/');
  }
  return uri;
}

function displayDomainInfo(path, domainName, triggerName, triggerProperties) {
  console.log(`triggerName: ${yellow(triggerName)}`);
  console.log(`methods: ${yellow(triggerProperties.Methods || triggerProperties.methods)}`);
  console.log(`url: ` + yellow(generateUri(path, domainName)));
}


function matchPathConfig(pathConfigs, serviceName, functionName) {
  for (const config of pathConfigs) {
    if (config.realServiceName === serviceName && config.realFunctionName === functionName) {
      return config;
    }
  }
  return null;
}

async function getPathConfigFromRosTemplate(rosResources) {
  const pathConfig = [];

  for (const res of Object.values(rosResources)) {
    if ((res || {}).Type === 'ALIYUN::FC::CustomDomain') {

      const resProp = res.Properties || {};
      const domainName = resProp.DomainName;
      const routes = (resProp.RouteConfig || {}).Routes;

      if (_.isEmpty(routes)) { continue; }

      for (const route of routes) {

        if (route.FunctionName['Fn::GetAtt']) {

          const realFunction = findRealFunction(rosResources, _.head(route.FunctionName['Fn::GetAtt']));
          realFunction.path = route.Path;
          realFunction.domainName = domainName;
          pathConfig.push(realFunction);
        }
      }
    }
  }
  return pathConfig;
}

async function detectRosHttpTrigger(rosResources) {

  const pathConfig = await getPathConfigFromRosTemplate(rosResources);

  for (const v of Object.values(rosResources)) {
    if ((v || {}).Type === 'ALIYUN::FC::Trigger') {
      const triggerProp = v.Properties || {};
      const triggerProperties = triggerProp.TriggerConfig;

      const serviceName = triggerProp.ServiceName;
      const functionName = triggerProp.FunctionName;
      const triggerName = triggerProp.TriggerName;

      const config = matchPathConfig(pathConfig, serviceName, functionName);

      console.log();

      if (config) {
        displayDomainInfo(config.path, config.domainName, triggerName, triggerProperties);
        continue;
      }

      await trigger.displayTriggerInfo(serviceName, functionName, triggerName, triggerProp.TriggerType, triggerProperties, '', rosResources);
    }
  }
}

async function saveTemplate(baseDir, rosTemplateData) {
  const rosTemplatePath = path.resolve(baseDir, ROS_TEMPLATE_PATH);

  let rosTemplateObj;
  try {
    rosTemplateObj = JSON.parse(rosTemplateData);
  } catch (err) {
    console.error(red(`Unable to parse JSON file ${rosTemplateData}. Error: ${err}`));
  }
  // format output
  await fs.outputFile(rosTemplatePath, JSON.stringify(rosTemplateObj, null, 4));

  return rosTemplateObj;
}

function showRosDeployNextTips(region) {

  const url = `https://ros.console.aliyun.com/#/stack/${region}`;

  console.log(green(`\nDeploy success, you can also login to ${url} to see more deploy logs.\n`));
}

function displayParameters(parameters) {
  if (_.isEmpty(parameters)) { return; }

  console.log('ROS Stack Parameters:\n');

  const table = getTableInstance(parametersTableHeads);

  _.forEach(parameters, p => {
    table.push([p.ParameterKey, p.ParameterValue]);
  });

  console.log(table.toString() + '\n');
}

function getTableInstance(head) {
  return new Table({
    head,
    style: {
      head: ['green'],
      border: [] //disable colors for the border
    }
  });
}

async function getStack(rosClient, stackId, region) {
  const params = {
    'RegionId': region,
    'StackId': stackId
  };

  return await rosClient.request('GetStack', params, requestOption);
}

async function deleteChangeSet(rosClient, changeSetId, region) {
  const params = {
    'RegionId': region,
    'ChangeSetId': changeSetId
  };
  await rosClient.request('DeleteChangeSet', params, requestOption);
}

function transformParameters(parameters) {
  return parameters.reduce((acc, cur, idx) => {
    const parseKey = `Parameters.${idx + 1}.ParameterKey`;
    const parseValue = `Parameters.${idx + 1}.ParameterValue`;

    acc[parseKey] = cur.ParameterKey;
    acc[parseValue] = cur.ParameterValue;
    return acc;
  }, {});
}

function validateParameters(parametersInTpl = {}, parameterOverride = {}) {
  for (const key of Object.keys(parameterOverride)) {
    if (!_.includes(Object.keys(parametersInTpl), key)) {
      throw new Error(`Incorrect parameters: '${key}' are not defined in yml.`);
    }
  }
}

function parseParameterOverride(parameterOverride) {
  const parameters = [];
  for (const [key, value] of Object.entries(parameterOverride)) {
    parameters.push({
      'ParameterKey': key,
      'ParameterValue': value
    });
  }
  return parameters;
}

async function deleteStack(rosClient, stackId, region) {
  const params = {
    'RegionId': region,
    'StackId': stackId
  };

  debug('delete stack, params %s', params);
  await rosClient.request('DeleteStack', params, requestOption);
}

// { a: b } -> { a=b }
function convertToEqualSign(parameterOverride) {
  return parseParameterOverride(parameterOverride).map(m => {
    const key = m.ParameterKey;
    const value = m.ParameterValue;
    return `${key}=${value}`;
  });
}

function parseRosParameters(parametersInTpl, parameterOverride) {
  if (_.isEmpty(parameterOverride)) { return {}; }

  if (_.isEmpty(parametersInTpl)) {
    if (!_.isEmpty(parameterOverride)) {
      console.warn(red(`\nDetectionWarning: ${convertToEqualSign(parameterOverride).join(', ')} are not defined in yml.`));
    }
    return {};
  }

  validateParameters(parametersInTpl, parameterOverride);

  return transformParameters(parseParameterOverride(parameterOverride));
}

async function waitStackDeleted(rosClient, stackId, region, stackName) {
  let exist;
  do {
    exist = true;

    await time.sleep(500);

    const rs = await getStack(rosClient, stackId, region);
    const status = rs.Status;

    if (status === 'DELETE_COMPLETE') {
      exist = false;
    }

    console.log(`stack: '${stackName}' already deleted, waiting for status to be 'DELETE_COMPLETE', now is ${rs.Status}`);
  } while (exist);
}

function transformAsyncConfiguration (resources = {}, region, accountId) {
  _.forEach(resources, function(value) {
    if (value.Type === 'ALIYUN::FC::Function' && value.Properties) {
      if (value.Properties.AsyncConfiguration && value.Properties.AsyncConfiguration.Destination) {
        const { OnSuccess, OnFailure } = value.Properties.AsyncConfiguration.Destination;
        if (OnSuccess) {
          value.Properties.AsyncConfiguration.Destination.OnSuccess = OnSuccess.replace(':::', `:${region}:${accountId}:`);
        }
        if (OnFailure) {
          value.Properties.AsyncConfiguration.Destination.OnFailure = OnFailure.replace(':::', `:${region}:${accountId}:`);
        }
      }
    }
  });
}

async function transformRosYml (baseDir, tpl, tplPath) {
  for (const key of Object.keys(tpl.Resources)) {
    const { Type, Properties: properties } = tpl.Resources[key];
    if (Type === 'ALIYUN::FC::Function' && properties.Runtime !== 'custom-container' && !properties.Code) {
      if (!properties.CodeUri) {
        throw new Error(`ALIYUN::FC::Function Code is empty.`);
      }
      const bucketName = await processOSSBucket();
      const ossClient = await client.getOssClient(bucketName);

      const ignore = await fc.generateFunIngore(baseDir, properties.CodeUri);
      const oss = await zipCodeToOss({
        tplPath,
        ignore,
        ossClient,
        codeUri: properties.CodeUri,
        runtime: properties.Runtime,
        isRosCodeUri: true
      });

      if (!oss.objectName) {
        throw new Error(`Codeuri ${properties.CodeUri} upload to oss error.`);
      }
      tpl.Resources[key].Properties.Code = {
        OssBucketName: bucketName,
        OssObjectName: oss.objectName
      };
      delete tpl.Resources[key].Properties.CodeUri;
    }
  }
  const packedYmlPath = path.join(process.cwd(), 'template.packaged.yml');
  outputTemplateFile(packedYmlPath, tpl);
}

async function deployByRos(baseDir, stackName, tpl, assumeYes, parameterOverride = {}, tplPath) {
  const profile = await getProfile();
  const region = profile.defaultRegion;
  const { accountId } = profile;

  transformAsyncConfiguration(tpl.Resources, region, accountId);
  if (!tpl.Transform) {
    await transformRosYml(baseDir, tpl, tplPath);
  }
  const rosClient = await client.getRosClient();

  let { stackId, stackStatus } = await findRosStack(rosClient, region, stackName);

  let changeSetId;
  let createStack = false;
  if (!stackId) { // create
    const changeSet = await createChangeSet(rosClient, region, stackName, tpl, parseRosParameters(tpl.Parameters, parameterOverride));

    changeSetId = changeSet.changeSetId;
    stackId = changeSet.stackId;
    createStack = true;
  } else { // update

    if (_.includes(DELETE_LAST_DEPLOYMENT_FAILED_STATUS, stackStatus)) {
      if (!assumeYes) {
        if (await promptForConfirmContinue(`The status of last deployed stack is ${stackStatus}, fun want to delete it and redeploy it.`)) {
          await deleteStack(rosClient, stackId, region);
          await waitStackDeleted(rosClient, stackId, region, stackName);
          await deployByRos(baseDir, stackName, tpl, assumeYes, parameterOverride);
          return;
        }
      }
    }

    changeSetId = await updateChangeSet(
      rosClient, region, stackName, stackId, tpl, parseRosParameters(tpl.Parameters, parameterOverride));
  }

  const { changes, parameters, status, executionStatus } = await getChangeSet(rosClient, changeSetId, region);

  displayChanges(changes);
  displayParameters(parameters);

  const canDelete = _.includes(ROS_STATUS_FOR_DELETE_CHANGESET, status) && _.includes(ROS_EXECUTE_STATUS_FOR_DELETE_CHANGESET, executionStatus);

  if (!assumeYes) {
    if (!await promptForConfirmContinue('Please confirm to continue.')) {
      if (canDelete) { await deleteChangeSet(rosClient, changeSetId, region); }
      // 当删除类型为 CREATE 的更改集时，需要自行删除其关联的资源栈。
      if (status === 'CREATE_COMPLETE' && createStack) { await deleteStack(rosClient, stackId, region); }
      return;
    }
  }

  await promiseRetry(async (retry, times) => {
    try {
      await execChangeSet(rosClient, region, changeSetId);
    } catch (e) {
      if (e.code === 'NotSupported' && e.data && e.data.Message
        && e.data.Message.indexOf('StatusEnum.CREATE_IN_PROGRESS is not supported')) {
        await time.sleep(1000);
        console.log('changeSet is in \'StatusEnum.CREATE_IN_PROGRESS\' status, try to exectue again');
        retry(e);
      } else {
        throw e;
      }
    }
  });
  console.log('ROS Stack Events:\n');

  let isComplete = false;
  do {
    const { completed, events} = await getStackEvents(rosClient, stackId, region, stackName);
    displayEventsStatus(events, stackName);

    isComplete = completed;
  } while (!isComplete);

  const rosTemplateData = await getTemplate(rosClient, stackId, region);
  const rosTemplateObj = await saveTemplate(baseDir, rosTemplateData);

  await detectRosHttpTrigger(rosTemplateObj.Resources);

  const res = await getStack(rosClient, stackId, region);
  displayOutputs(res.Outputs);

  showRosDeployNextTips(region);
}

module.exports = {
  deployByRos,
  validateParameters
};