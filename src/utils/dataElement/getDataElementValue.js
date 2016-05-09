var state = require('../../state');
var cleanText = require('../string/cleanText');

module.exports = function(name, suppressDefault) {
  var dataDef = state.getDataElementDefinition(name);

  if (!dataDef) {
    return state.getPropertySettings().undefinedVarsReturnEmpty ? '' : null;
  }

  var storeLength = dataDef.storeLength;
  var delegate = state.getDelegate(dataDef.modulePath);
  var value = delegate.exports(dataDef.settings);

  if (dataDef.cleanText) {
    value = cleanText(value);
  }

  if (value === undefined && storeLength) {
    value = state.getCachedDataElementValue(name, storeLength);
  } else if (value !== undefined && storeLength) {
    state.cacheDataElementValue(name, storeLength, value);
  }

  if (value === undefined && !suppressDefault) {
    // Have to wrap "default" in quotes since it is a keyword.
    /*eslint-disable dot-notation*/
    value = dataDef['default'] || '';
    /*eslint-enable dot-notation*/
  }

  if (dataDef.forceLowerCase && value.toLowerCase) {
    value = value.toLowerCase();
  }

  return value;
};
