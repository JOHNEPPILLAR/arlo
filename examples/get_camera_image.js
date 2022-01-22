// file deepcode ignore PromiseNotCaughtGeneral: <example code>
// file deepcode ignore Ssrf: <example code>

import DebugModule from 'debug';
import fs from 'fs';
import axios from 'axios';
// eslint-disable-next-line import/no-unresolved, import/extensions
import Arlo from '../lib/arlo.mjs';

const debug = new DebugModule('Arlo:Example_get_camera_image');

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

    // Get latest image from cam
    let imageURL;
    try {
      imageURL = await arlo.getSnapshotURL(cam.deviceId);

      // Download presigned last image
      await axios
        .get(imageURL.presignedLastImageUrl, { responseType: 'stream' })
        .then((response) => {
          response.data.pipe(fs.createWriteStream('presignedLastImageUrl.jpg'));
        });

      // Download presigned full frame snapshot image
      await axios
        .get(imageURL.presignedFullFrameSnapshotUrl, { responseType: 'stream' })
        .then((response) => {
          response.data.pipe(
            fs.createWriteStream('presignedFullFrameSnapshotUrl.jpg')
          );
        });
    } catch (err) {
      debug(err.message);
    }
  });
}

setupService();
