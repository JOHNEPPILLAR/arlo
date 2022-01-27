import DebugModule from 'debug';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Arlo from '../lib/arlo.mjs';

const debug = new DebugModule('Arlo:Example_deactivate_camera');

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

  arlo.on(Arlo.EVENT_MEDIA_UPLOAD, (info) => {
    debug('New media event');
    debug(info);
  });

  arlo.on(Arlo.EVENT_LOGOUT, () => {
    debug('Logged out');
  });

  arlo.once(Arlo.EVENT_GOT_DEVICES, async (devices) => {
    debug('Found devices');

    const cameras = devices.filter((d) => {
      // eslint-disable-next-line no-return-assign, no-param-reassign
      return (d.deviceType = 'camera');
    });
    const [cam] = cameras; // Use first cam found

    if (cam.length === 0) {
      debug('No cameras found');
      return;
    }

    // De-activate & activate fist camera
    let camStatus;
    try {
      camStatus = await arlo.disarm(cam.deviceId);
      debug(`Updated active status: ${camStatus}`);

      // Wait before turning it back on
      setTimeout(async () => {
        camStatus = await arlo.arm(cam.deviceId);
        debug(`Updated active status: ${camStatus}`);
      }, 3000);
    } catch (err) {
      debug(err.message);
    }
  });
}

setupService();
