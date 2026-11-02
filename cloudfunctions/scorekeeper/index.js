const { createHandler } = require('./service.cjs');
const { createHandler: createV2Handler } = require('./v2.cjs');
const { createBackupDispatcher } = require('./github-backup.cjs');
let handler, handlerV2;

// Deploy this as an event cloud function, invoked by CloudBase Web SDK callFunction.
exports.main = async (event) => {
  if (!handler) {
    const cloudbase = require('@cloudbase/node-sdk');
    const app = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
    const db = app.database();
    handler = createHandler({ db });
    handlerV2 = createV2Handler({ db, onGameFinished: createBackupDispatcher() });
  }
  return event?.apiVersion === 2 ? handlerV2(event) : handler(event);
};
