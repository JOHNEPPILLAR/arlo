import DebugModule from 'debug';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Arlo from '../lib/arlo.mjs';

const debug = new DebugModule('Arlo:Example_login');

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

async function logInToArlo() {
  const arlo = new Arlo(config);
  if (arlo instanceof Error) {
    debug(arlo.message);
    return false;
  }

  debug(`Login to Arlo`);
  const sucess = await arlo.login();
  if (!sucess) {
    debug('Not able to login to Arlo');
    return false;
  }
  debug('Logged into Arlo');
  return true;
}

logInToArlo();
