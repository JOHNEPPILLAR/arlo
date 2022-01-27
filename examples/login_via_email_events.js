import DebugModule from 'debug';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Arlo from '../lib/arlo.mjs';

const debug = new DebugModule('Arlo:Example_login_via_email_events');

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
  mfaViaEmail: true,
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

  arlo.on(Arlo.EVENT_BATTERY, (info) => {
    debug('Battery event');
    debug(info);
  });

  arlo.on(Arlo.EVENT_MEDIA_UPLOAD, (info) => {
    debug('New media event');
    debug(info);
  });

  arlo.on(Arlo.EVENT_LOGOUT, () => {
    debug('Logged out');
  });

  arlo.once(Arlo.EVENT_GOT_DEVICES, (devices) => {
    debug('Found devices');
    debug(devices);
  });
}

setupService();
