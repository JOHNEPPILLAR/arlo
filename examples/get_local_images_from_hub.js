import DebugModule from 'debug';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Arlo from '../lib/arlo.mjs';

const debug = new DebugModule('Arlo:Example_get_local_images_from_hub');

const arloUser = '****@****.****';
const arloPassword = '****';
const emailUser = '****@gmail.com';
const emailPassword = '****';
const emailServer = 'imap.gmail.com';
const updatePropertiesEvery = 5;

// *** NOTE ***
// Make sure gmail has imap enabled

const config = {
  arloUser,
  arloPassword,
  mfa: true,
  emailUser,
  emailPassword,
  emailServer,
  updatePropertiesEvery,
};

async function setupService() {
  const arlo = new Arlo(config);
  if (arlo instanceof Error) {
    debug(arlo.message);
    return;
  }

  debug(`Login to Arlo`);
  const sucess = await arlo.login();
  if (!sucess) {
    debug('Not able to login to Arlo');
    return;
  }
  debug('Logged into Arlo');

  arlo.on(Arlo.EVENT_LOGOUT, () => {
    debug('Logged out');
  });

  arlo.once(Arlo.EVENT_GOT_DEVICES, async () => {
    // Wait for all events to be processed
    // Then request to open local storage from hub
    // You also need an empty cert folder to store certs from hub
    setTimeout(() => {
      arlo.openLocalMediaLibrary();
    }, 3000);
  });

  arlo.once(Arlo.EVENT_RATLS, async () => {
    debug('RATLS event, getting local library');

    let recordings;
    try {
      recordings = await arlo.getLocalMediaLibrary();
    } catch (err) {
      debug(err);
      return;
    }

    debug(recordings);
  });
}

setupService();
