/***************************************************************************************
 * (c) 2017 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 ****************************************************************************************/

var logger = require('./logger');
var normalizeSyntheticEvent = require('./normalizeSyntheticEvent');
var buildRuleExecutionOrder = require('./buildRuleExecutionOrder');
var createNotifyMonitors = require('./createNotifyMonitors');
var getNamespacedStorage = require('./getNamespacedStorage');
var createExecuteDelegateModule = require('./createExecuteDelegateModule');
var localStorage = getNamespacedStorage('localStorage');
var Promise = require('@adobe/reactor-promise');
var PROMISE_TIMEOUT = 5000;

module.exports = function(
  _satellite,
  rules,
  moduleProvider,
  replaceTokens,
  getShouldExecuteActions
) {
  var lastPromiseInQueue = Promise.resolve();
  var notifyMonitors = createNotifyMonitors(_satellite);
  var executeDelegateModule = createExecuteDelegateModule(
    moduleProvider,
    replaceTokens
  );

  var getModuleDisplayNameByRuleComponent = function(ruleComponent) {
    var moduleDefinition = moduleProvider.getModuleDefinition(
      ruleComponent.modulePath
    );
    return (
      (moduleDefinition && moduleDefinition.displayName) ||
      ruleComponent.modulePath
    );
  };

  var getErrorMessage = function(
    ruleComponent,
    rule,
    errorMessage,
    errorStack
  ) {
    var moduleDisplayName = getModuleDisplayNameByRuleComponent(ruleComponent);
    return (
      'Failed to execute ' +
      moduleDisplayName +
      ' for ' +
      rule.name +
      ' rule. ' +
      errorMessage +
      (errorStack ? '\n' + errorStack : '')
    );
  };

  var logActionError = function(action, rule, e) {
    logger.error(getErrorMessage(action, rule, e.message, e.stack));
  };

  var logConditionError = function(condition, rule, e) {
    logger.error(getErrorMessage(condition, rule, e.message, e.stack));

    notifyMonitors('ruleConditionFailed', {
      rule: rule,
      condition: condition,
    });
  };

  var logConditionNotMet = function(condition, rule) {
    var conditionDisplayName = getModuleDisplayNameByRuleComponent(condition);

    logger.log(
      'Condition ' +
        conditionDisplayName +
        ' for rule ' +
        rule.name +
        ' not met.'
    );

    notifyMonitors('ruleConditionFailed', {
      rule: rule,
      condition: condition,
    });
  };

  var logRuleCompleted = function(rule) {
    logger.log('Rule "' + rule.name + '" fired.');
    notifyMonitors('ruleCompleted', {
      rule: rule,
    });
  };

  var normalizeError = function(e) {
    if (!e) {
      e = new Error(
        'The extension triggered an error, but no error information was provided.'
      );
    }

    if (!(e instanceof Error)) {
      e = new Error(String(e));
    }

    return e;
  };

  var isConditionMet = function(condition, result) {
    return (result && !condition.negate) || (!result && condition.negate);
  };

  var addRuleToQueue = function(rule, syntheticEvent) {
    if (rule.conditions) {
      rule.conditions.forEach(function(condition) {
        lastPromiseInQueue = lastPromiseInQueue.then(function() {
          var conditionPromise = new Promise(function(resolve) {
            resolve(
              executeDelegateModule(condition, syntheticEvent, [syntheticEvent])
            );
          })
            .catch(function(e) {
              e = normalizeError(e, condition);
              logConditionError(condition, rule, e);
              return Promise.reject(e);
            })
            .then(function(result) {
              if (!isConditionMet(condition, result)) {
                logConditionNotMet(condition, rule);
                return Promise.reject();
              }
            });

          var timeoutPromise = new Promise(function(resolve, reject) {
            // We reject instead of resolve because we don't want
            // remaining conditions and actions to run.
            setTimeout(reject, PROMISE_TIMEOUT);
          });

          return Promise.race([conditionPromise, timeoutPromise]);
        });
      });
    }

    if (getShouldExecuteActions() && rule.actions) {
      rule.actions.forEach(function(action) {
        lastPromiseInQueue = lastPromiseInQueue.then(function() {
          var actionPromise = new Promise(function(resolve) {
            resolve(
              executeDelegateModule(action, syntheticEvent, [syntheticEvent])
            );
          }).catch(function(e) {
            e = normalizeError(e);
            logActionError(action, rule, e);
          });

          var timeoutPromise = new Promise(function(resolve) {
            // We resolve instead of reject because we want remaining actions to run.
            setTimeout(resolve, PROMISE_TIMEOUT);
          });

          return Promise.race([actionPromise, timeoutPromise]);
        });
      });
    }

    lastPromiseInQueue = lastPromiseInQueue.then(function() {
      logRuleCompleted(rule);
    });

    // Allows later rules to keep running when an error occurs within this rule.
    lastPromiseInQueue = lastPromiseInQueue.catch(function() {});
  };

  var checkConditions = function(rule, syntheticEvent) {
    var condition;

    if (rule.conditions) {
      for (var i = 0; i < rule.conditions.length; i++) {
        condition = rule.conditions[i];

        try {
          var result = executeDelegateModule(condition, syntheticEvent, [
            syntheticEvent,
          ]);

          if (!isConditionMet(condition, result)) {
            logConditionNotMet(condition, rule);
            return;
          }
        } catch (e) {
          logConditionError(condition, rule, e);
          return;
        }
      }
    }
    runActions(rule, syntheticEvent);
  };

  var runActions = function(rule, syntheticEvent) {
    if (getShouldExecuteActions()) {
      (rule.actions || []).forEach(function(action) {
        try {
          executeDelegateModule(action, syntheticEvent, [syntheticEvent]);
        } catch (e) {
          logActionError(action, rule, e);
        }
      });

      logRuleCompleted(rule);
    }
  };

  var initEventModule = function(ruleEventPair) {
    var rule = ruleEventPair.rule;
    var event = ruleEventPair.event;
    event.settings = event.settings || {};

    var moduleName;
    var extensionName;

    try {
      moduleName = moduleProvider.getModuleDefinition(event.modulePath).name;
      extensionName = moduleProvider.getModuleExtensionName(event.modulePath);

      var syntheticEventMeta = {
        $type: extensionName + '.' + moduleName,
        $rule: {
          id: rule.id,
          name: rule.name,
        },
      };

      /**
       * This is the callback that executes a particular rule when an event has occurred.
       * @callback ruleTrigger
       * @param {Object} [syntheticEvent] An object that contains detail regarding the event
       * that occurred.
       */
      var trigger = function(syntheticEvent) {
        notifyMonitors('ruleTriggered', {
          rule: rule,
        });

        var normalizedSyntethicEvent = normalizeSyntheticEvent(
          syntheticEventMeta,
          syntheticEvent
        );

        if (localStorage.getItem('queue')) {
          addRuleToQueue(rule, normalizedSyntethicEvent);
        } else {
          checkConditions(rule, normalizedSyntethicEvent);
        }
      };

      executeDelegateModule(event, null, [trigger]);
    } catch (e) {
      logger.error(getErrorMessage(event, rule, e.message, e.stack));
    }
  };

  buildRuleExecutionOrder(rules).forEach(initEventModule);
};
