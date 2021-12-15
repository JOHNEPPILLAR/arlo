/**
 * Import libraries
 */
import DebugModule from 'debug';
import axios from 'axios';
import extend from 'util';
import { EventEmitter } from 'events';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import moment from 'moment';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import https from 'https';
import fs from 'fs';
import path from 'path';
import forge from 'node-forge';
// eslint-disable-next-line import/no-unresolved
import { setTimeout } from 'timers/promises';

/**
 * Import internal libraries
 */
import mfa from './mfa.mjs';

const debug = new DebugModule('Arlo:main');
const debugComm = new DebugModule('Arlo:axios');
const debugEvent = new DebugModule('Arlo:event');

// URL's
const API_DOMAIN = 'myapi.arlo.com';
const ARLO_URLS = {};
ARLO_URLS.API_ROOT = `https://${API_DOMAIN}`;
ARLO_URLS.WEB = `${ARLO_URLS.API_ROOT}/hmsweb`;
ARLO_URLS.LOGOUT = `${ARLO_URLS.WEB}/logout`;
ARLO_URLS.WEB_CLIENT = `${ARLO_URLS.WEB}/client`;
ARLO_URLS.SUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/subscribe`;
ARLO_URLS.UNSUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/unsubscribe`;
ARLO_URLS.WEB_USERS = `${ARLO_URLS.WEB}/users`;
ARLO_URLS.DEVICES_V2 = `${ARLO_URLS.WEB}/v2/users/devices`;
ARLO_URLS.DEVICES = `${ARLO_URLS.WEB_USERS}/devices`;
ARLO_URLS.DEVICE = `${ARLO_URLS.WEB_USERS}/device`;
ARLO_URLS.AUTOMATIONACTIVE = `${ARLO_URLS.DEVICES}/automation/active`;
ARLO_URLS.SERVICE_LEVEL_SETTINGS = `${ARLO_URLS.WEB_USERS}/serviceLevel/settings`;
ARLO_URLS.SERVICE_LEVELS = `${ARLO_URLS.WEB_USERS}/serviceLevel/v4`;
ARLO_URLS.CAPABILITIES = `${ARLO_URLS.WEB_USERS}/capabilities`;
ARLO_URLS.FEATURES = `${ARLO_URLS.WEB_USERS}/subscription/smart/features`;
ARLO_URLS.EMERGENCY_LOCATIONS = `${ARLO_URLS.WEB_USERS}/emergency/locations`;
ARLO_URLS.NOTIFY = `${ARLO_URLS.DEVICES}/notify`;
ARLO_URLS.START_STREAM = `${ARLO_URLS.DEVICES}/startStream`;
ARLO_URLS.STOP_STREAM = `${ARLO_URLS.DEVICES}/stopStream`;
ARLO_URLS.SNAPSHOT = `${ARLO_URLS.DEVICES}/fullFrameSnapshot`;
ARLO_URLS.LIBRARY_SUMMARY = `${ARLO_URLS.WEB_USERS}/library/metadata`;
ARLO_URLS.LIBRARY = `${ARLO_URLS.WEB_USERS}/library`;
ARLO_URLS.START_NEW_SESSION = `https://${API_DOMAIN}/hmsweb/users/session/v2`;

// Events
const EVENT_LOGGED_IN = 'logged_in';
const EVENT_MESSAGE = 'message';
const EVENT_CONNECTED = 'connected';
const EVENT_FF_SNAPSHOT_AVAILABLE = 'fullFrameSnapshotAvailable';
const EVENT_MEDIA_UPLOAD = 'mediaUploadNotification';
const EVENT_FOUND = 'device_found';
const EVENT_GOT_DEVICES = 'got_all_devices';
const EVENT_MODE = 'activeAutomations';
const EVENT_SIREN = 'siren';
const EVENT_DEVICES = 'devices';
const EVENT_BATTERY = 'batteryLevel';
const EVENT_DEVICE_UPDATE = 'deviceUpdate';
const EVENT_LOGOUT = 'logout';
const EVENT_RATLS = 'storage/ratls';
const EVENT_PROPERTIES = 'properties_updated';

// Device Types
const TYPE_ARLOQS = 'arloqs';
const TYPE_ARLOQ = 'arloq';
const TYPE_BASESTATION = 'basestation';
const TYPE_CAMERA = 'camera';

/**
 * Arlo class
 *
 * @class Arlo
 */
class Arlo extends EventEmitter {
  /**
   * Creates an instance of Arlo.
   *
   * @param {Object} options
   * @memberof Arlo
   * Params:
   *    arloUser (email address),
   *    arloPassword (password),
   *    updatePropertiesEvery (update device properties: in minutes),
   *    token (Arlo mobile app token)
   *    localAppID (Static Arlo mobile app id)
   */
  constructor(options) {
    super();

    if (!options) {
      debug('No options passed in');
      this._fatal();
    }
    this.config = options;

    this.loggedIn = false;
    this.connected = false;
    this.cameras = [];
    this.timers = [];
    this.RATLS = {};

    // Check constructor params
    if (typeof options.arloUser === 'undefined')
      // eslint-disable-next-line no-constructor-return
      return Error('No Arlo user param');
    if (typeof options.arloPassword === 'undefined')
      // eslint-disable-next-line no-constructor-return
      return Error('No Arlo password param');
    if (typeof options.token === 'undefined')
      // eslint-disable-next-line no-constructor-return
      return Error('No Arlo mobile app token param');
    if (typeof options.localAppID === 'undefined')
      // eslint-disable-next-line no-constructor-return
      return Error('No Arlo mobile app ID param');
    if (typeof options.mobilePayload === 'undefined')
      // eslint-disable-next-line no-constructor-return
      return Error('No Arlo mobile payload param');
    // options.updatePropertiesEvery is optional

    // Set device properties pooling interval
    if (typeof options.updatePropertiesEvery !== 'undefined')
      this.updatePropertiesTimer = options.updatePropertiesEvery * 60000;

    this.localAppID = options.localAppID;
    this.mobilePayload = options.mobilePayload;

    const jar = new CookieJar();
    this.axiosClient = wrapper(axios.create({ jar }));
  }

  /** *************************
   * Public functions
   ************************* */

  /**
   * Login to Arlo
   */
  async login() {
    this.token = this.config.token;

    this.headers = {
      Host: 'ocapi.arlo.com',
      'Content-Type': 'application/json',
      Connection: 'keep-alive',
      'X-DreamFactory-Api-Key':
        '8c6b41f20897aa6b3f852a1ca3aded0471888e2e119da2737de2a9c797a8ae8d',
      Accept: '*/*',
      'Accept-Language': 'en-gb',
      accessToken: this.config.token,
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': 'Arlo/2967 CFNetwork/1312 Darwin/21.0.0',
      Pragma: 'no-cache',
    };

    let proceed = await mfa._validateToken.call(this);

    if (proceed instanceof Error || typeof proceed === 'undefined') {
      return false;
    }
    if (!proceed) {
      // Token expired
      this.headers.authorization = null; // Clear out old token;

      proceed = await mfa._getAuthToken.call(
        this,
        this.config.arloUser,
        this.config.arloPassword,
      );
      if (!proceed) return false;

      proceed = await mfa._getFactors.call(this);
      if (!proceed) return false;

      proceed = await mfa._start2faAuth.call(this);
      if (!proceed) return false;

      proceed = await mfa._validateAccessToken.call(this);
      if (!proceed) return false;
    }

    debug('Logged in');
    this.loggedIn = true;
    this.emit(EVENT_LOGGED_IN, this.serialNumber);

    // Set timer to log out when token expires
    setTimeout(() => this._logOut.call(this), this.tokenExpires);

    // Reset headers
    this.headers = {
      accept: 'application/json',
      'content-type': 'application/json;charset=UTF-8',
      'auth-version': 2,
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': '(iPhone13,3 14_7_1) iOS Arlo 3.5',
      'accept-language': 'en-GB',
      authorization: this.token,
    };

    // Setup event stream listner
    await this._subscribe();

    return true;
  }

  /**
   * Arm base station/camera
   */
  arm(deviceID) {
    try {
      debug('Arm base station/camera');
      let device;
      if (deviceID === this.baseStation.deviceId) device = this.baseStation;
      else {
        const deviceIndex = this.cameras.findIndex(
          (d) => d.deviceId === deviceID,
        );
        if (deviceIndex < 0) {
          const err = new Error('No device found');
          debug(err);
          return err;
        }
        device = this.cameras[deviceIndex];
      }

      // Set new mode
      this._notify(
        {
          action: 'set',
          resource: 'modes',
          publishResponse: true,
          properties: { active: 'mode1' },
        },
        device,
      );
      return true;
    } catch (err) {
      debug(err.message);
      return err;
    }
  }

  /**
   * Disarm base station/camera
   */
  disarm(deviceID) {
    try {
      debug('Disarm base station/camera');
      let device;
      if (deviceID === this.baseStation.deviceId) device = this.baseStation;
      else {
        const deviceIndex = this.cameras.findIndex(
          (d) => d.deviceId === deviceID,
        );
        if (deviceIndex < 0) {
          const err = new Error('No device found');
          debug(err);
          return err;
        }
        device = this.cameras[deviceIndex];
      }

      // Set new mode
      this._notify(
        {
          action: 'set',
          resource: 'modes',
          publishResponse: true,
          properties: { active: 'mode0' },
        },
        device,
      );
      return true;
    } catch (err) {
      debug(err.message);
      return err;
    }
  }

  /**
   * Turn on/off camera
   */
  async setPrivacyActive(deviceID, privacy) {
    debug(`[${deviceID}] Turn camera ${privacy ? 'off' : 'on'}`);
    const deviceIndex = this.cameras.findIndex((d) => d.deviceId === deviceID);
    if (deviceIndex < 0) {
      const err = new Error('No device found');
      debug(err);
      return err;
    }

    let device;
    switch (this.cameras[deviceIndex].deviceType) {
      case TYPE_ARLOQS:
      case TYPE_ARLOQ:
        device = this.cameras[deviceIndex];
        break;
      case TYPE_CAMERA:
        device = this.baseStation;
        break;
      default:
        return false;
    }

    await this._notify(
      {
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        properties: { privacyActive: privacy },
      },
      device,
    );

    // Request device properties refresh
    await this._requestDeviceEvents.call(this, device);

    return true;
  }

  /**
   * Turn on the siren
   */
  async sirenOn(deviceID) {
    debug(`[${deviceID}] Turn siren on`);
    await this._notify(
      {
        action: 'set',
        resource: `siren/${deviceID}`,
        publishResponse: true,
        properties: {
          sirenState: 'on',
          duration: 300,
          volume: 8,
          pattern: 'alarm',
        },
      },
      deviceID,
    );

    // Request device properties refresh
    await this._refreshDeviceProperties(deviceID);

    return true;
  }

  /**
   * Turn off the siren
   */
  async sirenOff(deviceID) {
    debug(`[${deviceID}] Turn siren off`);
    await this._notify(
      {
        action: 'set',
        resource: `siren/${deviceID}`,
        publishResponse: true,
        properties: {
          sirenState: 'off',
          duration: 300,
          volume: 8,
          pattern: 'alarm',
        },
      },
      deviceID,
    );

    // Request device properties refresh
    await this._refreshDeviceProperties(deviceID);

    return true;
  }

  /**
   * Start camera video stream
   */
  async startStream(deviceID) {
    try {
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('No device found');
        debug(err);
        return err;
      }
      const device = this.cameras[deviceIndex];

      // Return existing stream url if stream already active
      if (device.streamActive) return device.streamURL;

      // Do not start stream if camera is in privacy mode
      if (device.properties.privacyActive) {
        // deepcode ignore ExceptionIsNotThrown:
        const err = new Error('Camera not active, unable to start stream');
        debug(`[${deviceID}] ${err}`);
        return err;
      }

      debug(`[${deviceID}] Camera is on, requesting stream`);
      const body = {
        from: `${this.userId}`,
        to: this.baseStation.deviceId,
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        transId: this._genTransID(),
        properties: {
          smartZoom: {
            topleftx: 0,
            toplefty: 0,
            bottomrightx: 3840,
            bottomrighty: 2160,
          },
          activityState: 'startUserStream',
          cameraId: deviceID,
        },
      };

      this._notify(body, device);

      const url = ARLO_URLS.START_STREAM;
      const response = await this._post(url, body, {
        xCloudId: this.baseStation.xCloudId,
      });

      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      if (!response.success) {
        debug(response.data.message);
        return new Error(response.data.message);
      }

      if (
        response.data.url === null ||
        typeof response.data.url === 'undefined'
      ) {
        const err = new Error(`Error getting stream for device: ${deviceID}`);
        debug(err.message);
        return err;
      }

      const rtnURL = response.data.url.replace('rtsp://', 'rtsps://');
      this.cameras[deviceIndex].streamURL = rtnURL;
      this.cameras[deviceIndex].streamActive = true;

      debug(`[${deviceID}] Stream URL: ${rtnURL}`);
      return rtnURL;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Stop camera video stream
   */
  async stopStream(deviceID) {
    try {
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('No device found');
        debug(err);
        return err;
      }

      debug(`[${deviceID}] Stop stream`);
      const body = {
        from: `${this.userId}`,
        to: this.baseStation.deviceId,
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        transId: this._genTransID(),
        properties: {
          activityState: 'stopUserStream',
          cameraId: deviceID,
        },
      };

      const url = ARLO_URLS.STOP_STREAM;
      const response = await this._post(url, body, {
        xCloudId: this.baseStation.xCloudId,
      });

      if (response instanceof Error) debug(response.message);

      debug(`[${deviceID}] Stream stopped`);
      this.cameras[deviceIndex].streamURL = '';
      this.cameras[deviceIndex].streamActive = false;
      return true;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Return the latest snapShot image URL
   */
  getSnapshotURL(deviceID) {
    try {
      debug(`[${deviceID}] Return snapshot URL`);
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('No device found');
        debug(err);
        return err;
      }
      const url = {
        presignedLastImageUrl: this.cameras[deviceIndex].presignedLastImageUrl,
        presignedFullFrameSnapshotUrl:
          this.cameras[deviceIndex].presignedFullFrameSnapshotUrl,
      };
      return url;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Take new snapshot
   */
  async getNewSnapshot(deviceID) {
    try {
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('Get FF snapshot: No device found');
        debug(err);
        return err;
      }

      const device = this.cameras[deviceIndex];

      // Do not take snapshot if app just launched
      if (typeof device.properties.privacyActive === 'undefined') return false;

      // Do not take snapshot if camera is in privacy mode
      if (device.properties.privacyActive) {
        debug(`[${deviceID}] Camera not active, unable to take FF snapshot`);
        return false;
      }

      debug(`[${deviceID}] Get new FF snapshot`);
      const url = ARLO_URLS.SNAPSHOT;
      const body = {};
      body.from = `${this.userId}`;
      body.to = this.baseStation.deviceId;
      body.transId = this._genTransID();
      body.resource = `cameras/${deviceID}`;
      body.action = 'set';
      body.publishResponse = true;
      body.properties = { activityState: 'fullFrameSnapshot' };

      const response = await this._post(url, body, {
        xCloudId: device.xCloudId,
      });
      if (response instanceof Error) {
        debug('Error getting FF snapshot');
        debug(response.message);
        return response;
      }

      if (!response.success) {
        debug(response.data.message);
        const err = new Error(response.data.message);
        throw err;
      }

      return true;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get media library summary data
   */
  async getMediaLibrarySummary(from) {
    try {
      debug(`Get media library summary data`);

      const url = ARLO_URLS.LIBRARY_SUMMARY;
      const body = {
        dateFrom: from || moment().format('yyyyMMDD'),
        dateTo: moment().format('yyyyMMDD'),
      };

      const response = await this._post(url, body, {});

      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (!response || !response.success)
        throw new Error('Error getting media library summary data');

      return response.data;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get media library data
   */
  async getMediaLibrary(from) {
    try {
      debug(`Get media library data`);

      const url = ARLO_URLS.LIBRARY;
      const body = {
        dateFrom: from || moment().format('yyyyMMDD'),
        dateTo: moment().format('yyyyMMDD'),
      };

      const response = await this._post(url, body, {});

      if (response instanceof Error) {
        const err = new Error('Error getting media library data');
        debug(response.message);
        throw err;
      }

      return response.data;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Download local media file
   */
  async downloadLocalMediaFile(filePath, outputLocationPath) {
    const url = `https://${this.RATLS.ip}:${this.RATLS.port}/hmsls/download/${filePath}`;

    // Bind certs to http agent
    const httpsAgent = new https.Agent({
      ca: this.RATLS.icaCert,
      cert: this.RATLS.peerCert,
      key: this.RATLS.privateKey,
      rejectUnauthorized: false, // Not able to get issuer cert if not set
    });

    // Set headers
    const headers = {
      authorization: `Bearer ${this.RATLS.token}`,
      'user-agent': this.headers['user-agent'],
    };

    const options = {
      method: 'GET',
      responseType: 'stream',
      // deepcode ignore Ssrf:
      url,
      httpsAgent,
      headers,
    };

    try {
      // Call local storage account and download recording
      debug('download file');
      // deepcode ignore Ssrf:
      const processFile = await axios(options).then((response) => {
        const writer = fs.createWriteStream(`${outputLocationPath}`);
        return new Promise((resolve, reject) => {
          response.data.pipe(writer);
          let error = null;
          writer.on('error', (err) => {
            error = err;
            writer.close();
            reject(err);
          });
          writer.on('close', () => {
            if (!error) {
              resolve(true);
            }
          });
        });
      });
      return processFile;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  async reSetBaseStation() {
    const directory = 'certs';

    debug(`Removing certs for: ${this.baseStation.deviceId}`);

    fs.readdir(directory, (err, files) => {
      if (err) throw err;

      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        fs.unlink(path.join(directory, file), (error) => {
          if (error) throw error;
        });
      }
    });

    // Re-start basestation
    /*
    const reStartUrl = `${ARLO_URLS.DEVICES}/restart`;
     const body = {
      deviceId: this.baseStation.deviceId,
    };
    debug('Restarting base station');
    await this._post(reStartUrl, body);
    */
  }

  async getLocalMediaLibrary(from) {
    // Check if certs exist
    const peerCrtPath = `./certs/peer.crt`;
    if (!fs.existsSync(peerCrtPath)) {
      // Generate local cert if not exists
      debug('Peer certs does not exists, Check if public pem exists');
      const publicPemPath = `./certs/public.pem`;
      if (fs.existsSync(publicPemPath)) {
        debug('Cert already exists, reading file');
        this.RATLS.publicKey = fs.readFileSync('./certs/public.pem', {
          encoding: 'utf8',
        });
        this.RATLS.privateKey = fs.readFileSync('./certs/private.pem', {
          encoding: 'utf8',
        });
      } else {
        try {
          debug('Generating new local certs');

          // Generate key pairs
          const keys = forge.pki.rsa.generateKeyPair(2048);

          // PEM serialize
          this.RATLS.privateKey = forge.pki.privateKeyToPem(keys.privateKey);
          this.RATLS.publicKey = forge.pki.publicKeyToPem(keys.publicKey);

          // Save certs
          fs.writeFileSync('./certs/private.pem', this.RATLS.privateKey);
          fs.writeFileSync('./certs/public.pem', this.RATLS.publicKey);
        } catch (err) {
          debug('Unable to save certs');
          throw err;
        }
      }

      debug('Strip return, header and footer from cert');
      let publicKey = this.RATLS.publicKey.replace(/(\r\n|\n|\r)/gm, '');
      publicKey = publicKey.replace('-----BEGIN PUBLIC KEY-----', '');
      publicKey = publicKey.replace('-----END PUBLIC KEY-----', '');

      debug('Get RATLS certs');
      const url = `${ARLO_URLS.DEVICES}/v2/security/cert/create`;
      const body = {
        uuid: this.localAppID,
        publicKey,
        uniqueIds: [`${this.userId}_${this.baseStation.deviceId}`],
      };

      const response = await this._post(url, body);
      if (response instanceof Error) {
        debug(response.message);
        throw new Error('Error getting media library data');
      }

      if (!response.success) {
        const err = new Error(response.data.message);
        debug(err.message);
        return err;
      }

      debug('Saving RATLS certs');
      this.RATLS.peerCert = this._formatToPem(
        response.data.certsData[0].peerCert,
      );
      fs.writeFileSync('./certs/peer.crt', this.RATLS.peerCert);

      this.RATLS.deviceCert = this._formatToPem(
        response.data.certsData[0].deviceCert,
      );
      fs.writeFileSync('./certs/device.crt', this.RATLS.deviceCert);

      this.RATLS.icaCert = this._formatToPem(response.data.icaCert);
      fs.writeFileSync('./certs/ica.crt', this.RATLS.icaCert);

      this.RATLS.combined = `${this.RATLS.peerCert}\n${this.RATLS.icaCert}`;
      fs.writeFileSync('./certs/combined.crt', this.RATLS.combined);
    } else {
      debug('Loading RATLS certs');

      this.RATLS.privateKey = fs.readFileSync('./certs/private.pem', {
        encoding: 'utf8',
      });
      this.RATLS.icaCert = fs.readFileSync('./certs/ica.crt', {
        encoding: 'utf8',
      });
      this.RATLS.peerCert = fs.readFileSync('./certs/peer.crt', {
        encoding: 'utf8',
      });
    }

    // Connect to local storage device
    const dateFrom = from || moment().format('yyyyMMDD');
    const dateTo = moment().format('yyyyMMDD');
    const url = `https://${this.RATLS.ip}:${this.RATLS.port}/hmsls/list/${dateFrom}/${dateTo}`;

    // Bind certs to http agent
    const httpsAgent = new https.Agent({
      ca: this.RATLS.icaCert,
      cert: this.RATLS.peerCert,
      key: this.RATLS.privateKey,
      rejectUnauthorized: false, // Not able to get issuer cert if not set
    });

    // Set headers
    const headers = {
      authorization: `Bearer ${this.RATLS.token}`,
      accept: 'application/json',
      'user-agent': this.headers['user-agent'],
    };

    const options = {
      method: 'GET',
      // deepcode ignore Ssrf:
      url,
      httpsAgent,
      headers,
    };

    // Call local storage account to get recordings
    debug('Getting local storage recording data');

    let response;
    try {
      // deepcode ignore Ssrf:
      response = await axios(options);
    } catch (err) {
      debug(err.message);
      response = err;
    }

    if (response instanceof Error) {
      await this.reSetBaseStation.call(this);
      return Error('Error getting media library data');
    }

    if (!response || !response.data.success) {
      await this.reSetBaseStation.call(this);
      return Error('Error getting local media library data');
    }

    let recordsFound = 0;
    if (response.data.data) recordsFound = response.data.data.length;

    debug(`Found ${recordsFound} recordings`);
    return response.data.data || [];
  }

  /**
   * Request access to RATLS
   */
  async openLocalMediaLibrary() {
    try {
      debug('Request local storage activation');

      // Get RATLS token
      const url = `${ARLO_URLS.DEVICE}/ratls/token/${this.baseStation.deviceId}`;
      const response = await this._get(url);
      if (response instanceof Error || !response.success) {
        const err = new Error('Error getting media library data');
        debug(response.message);
        throw err;
      }
      this.RATLS.token = response.data.ratlsToken;

      const body = {
        from: `${this.userId}`,
        to: this.baseStation.deviceId,
        action: 'open',
        resource: `storage/ratls`,
        publishResponse: false,
        transId: this._genTransID(),
      };

      await this._notify(body, this.baseStation);
      debug('Requested local storage activation');
    } catch (err) {
      debug(err.message);
      return err;
    }
    return true;
  }

  /**
   * Check if camera privacy mode is enabled
   */
  async isPrivacyEnabled(deviceID) {
    try {
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('Is cam Privacy Enabled: No device found');
        debug(err);
        return err;
      }

      const device = this.cameras[deviceIndex];

      if (device.properties.privacyActive) {
        debug(`[${deviceID}] Camera privacy mode active`);
        return true;
      }
      debug(`[${deviceID}] Camera privacy mode in-active`);
      return false;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Check if base station is armed
   */
  async isArmed() {
    debug(`Base station is ${this.baseStation.armed ? 'armed' : 'disarmed'}`);
    return this.baseStation.armed;
  }

  /**
   * Get service level settings from api
   */
  async getServiceLevelSettings() {
    debug('Getting service level settings data');
    try {
      const url = ARLO_URLS.SERVICE_LEVEL_SETTINGS;
      const response = await this._get(url);
      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (response.length === 0)
        throw new Error(`Error getting service level settings`);

      return response;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get capabilities from api
   */
  async getCapabilities() {
    debug('Getting capabilities data');
    try {
      const url = ARLO_URLS.CAPABILITIES;
      const response = await this._post(url);
      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (response.length === 0) throw new Error(`Error getting capabilities`);

      return response;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get features from api
   */
  async getFeatures() {
    debug('Getting features data');
    try {
      const xTransID = `FE!${uuid()}&time=${Date.now()}`;
      this.headers['x-transaction-id'] = xTransID;

      const url = `${ARLO_URLS.FEATURES}?eventId=${xTransID}`;
      const response = await this._get(url);
      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (response.length === 0) throw new Error(`Error getting features`);

      return response;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get emergency locations from api
   */
  async getEmergencyLocations() {
    debug('Getting emergency location data');
    try {
      const xTransID = `FE!${uuid()}&time=${Date.now()}`;
      this.headers['x-transaction-id'] = xTransID;

      const url = `${ARLO_URLS.EMERGENCY_LOCATIONS}?eventId=${xTransID}`;
      const response = await this._get(url);
      if (response instanceof Error) debug(response);
      return response;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get service levels from api
   */
  async getServiceLevels() {
    debug('Getting service levels data');
    try {
      const xTransID = `FE!${uuid()}&time=${Date.now()}`;
      this.headers['x-transaction-id'] = xTransID;

      const url = `${ARLO_URLS.SERVICE_LEVELS}?eventId=${xTransID}`;
      const response = await this._get(url);
      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (response.length === 0)
        throw new Error(`Error getting service levels`);

      return response;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /** *************************
   * Private functions
   ************************* */

  /**
   * Get device armed status
   */
  async _getArmedStatus() {
    debug('Getting armed status data');
    try {
      const url = ARLO_URLS.AUTOMATIONACTIVE;
      const response = await this._get(url);
      if (response instanceof Error) {
        debug(response.message);
        return response;
      }

      if (response.length === 0)
        throw new Error(`Error getting armed status settings`);

      const baseStationArmedData = response.data.filter(
        (device) => device.gatewayId === this.baseStation.deviceId,
      );

      if (baseStationArmedData[0].activeModes[0] === 'mode0')
        this.baseStation.armed = false;
      else this.baseStation.armed = true;
      return this.baseStation.armed;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get local media library data
   */
  // eslint-disable-next-line class-methods-use-this
  _formatToPem(cert) {
    const begin = '-----BEGIN CERTIFICATE-----\n';
    const end = '\n-----END CERTIFICATE-----';
    const newFormat = cert; // .replace(/.{64}/g, '$&' + '\n');
    return `${begin}${newFormat}${end}`;
  }

  /**
   * Get hmsweb version
   */
  async _getHmswebVersion() {
    debug('Get hmsweb version');
    const url = `${ARLO_URLS.WEB}/version`;

    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }
    this.hmsweb = response.version;
    return true;
  }

  /**
   * Request device properties refresh
   */
  async _refreshDeviceProperties(deviceID) {
    const deviceIndex = this.cameras.findIndex((d) => d.deviceId === deviceID);
    if (deviceIndex < 0) {
      const err = new Error('No device found');
      debug(err);
      return err;
    }
    await this._requestDeviceEvents.call(this, this.cameras[deviceIndex]);
    return true;
  }

  /**
   * Generate a unique string to use as transtion
   * key across event responses
   */
  // eslint-disable-next-line class-methods-use-this
  _genTransID() {
    const id1 = crypto.randomBytes(10).toString('hex').substr(1, 8);
    const id2 = crypto.randomBytes(10).toString('hex').substr(1, 6);
    const trandsID = `iOS!${id1}.${id2}!${Date.now()}`;
    return trandsID;
  }

  /**
   * Logout and reset so can log back in if needed
   */
  async _logOut() {
    this.connected = false;
    this.loggedIn = false;

    // Remove pooling timers
    this.timers.forEach((timer) => clearTimeout(timer));

    const url = ARLO_URLS.LOGOUT;
    const response = await this._put(url, {}, {});

    if (!response.success) debug(response);

    // Clear headers
    this.headers = {};
    this.subscribeHeaders = {};
    delete this.cookieJar;

    // End device event stream
    this.subscribeCancelToken.cancel('Logged out of arlo so cancel stream');

    // Emit logged out event
    this.emit(EVENT_LOGOUT, {});
  }

  /**
   * Send notify requests to Arlo api
   */
  async _notify(body, device) {
    try {
      if (!this.connected) return;

      const postBody = body;
      postBody.from = `${this.userId}`;
      postBody.to = device.deviceId;
      postBody.transId = this._genTransID();

      // Set url
      const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}`;

      // Issue request
      const response = await this._post(url, postBody, {
        xCloudId: device.xCloudId,
        'Content-Type': 'application/json; charset=utf-8',
      });

      if (response instanceof Error) {
        debugEvent(response);
        return;
      }
    } catch (err) {
      debugEvent(err);
    }
  }

  /**
   * Request device events
   */
  async _requestDeviceEvents(device) {
    if (!this.connected) return;

    let body;

    if (device.deviceType === TYPE_ARLOQS || device.deviceType === TYPE_ARLOQ) {
      debugEvent(`[${device.deviceId}] Request Q camera events`);
      try {
        const from = `${this.userId}`;
        const to = device.deviceId;
        body = [
          {
            from,
            to,
            action: 'get',
            resource: 'basestation',
            transId: this._genTransID(),
            publishResponse: false,
          },
          {
            from,
            to,
            action: 'get',
            resource: 'cameras',
            transId: this._genTransID(),
            publishResponse: false,
          },
          {
            from,
            to,
            action: 'get',
            resource: 'wifi/ap',
            transId: this._genTransID(),
            publishResponse: false,
          },
        ];
      } catch (err) {
        debugEvent(err);
        return;
      }
    }

    if (device.deviceType === TYPE_BASESTATION) {
      debugEvent(`[${device.deviceId}] Request smart hub state update`);
      try {
        const from = `${this.userId}`;
        const to = device.deviceId;
        body = [
          {
            from,
            to,
            action: 'get',
            resource: 'devices',
            transId: this._genTransID(),
            publishResponse: false,
          },
          {
            from,
            to,
            action: 'get',
            resource: 'storage',
            transId: this._genTransID(),
            publishResponse: false,
          },
        ];
        const cams = this.cameras.filter((d) => d.deviceType === TYPE_CAMERA);
        cams.map((c) => {
          body.push({
            from,
            to,
            action: 'get',
            resource: `siren/${c.deviceId}`,
            transId: this._genTransID(),
            publishResponse: false,
          });
          return true;
        });
      } catch (err) {
        debugEvent(err);
        return;
      }
    }

    try {
      // Issue request
      const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}`;
      const response = await this._post(url, body, {
        xCloudId: device.xCloudId,
      });

      if (response instanceof Error) debugEvent(response);
    } catch (err) {
      debugEvent(err);
    }
  }

  /**
   * Subscribe a device to events
   */
  async _subscribeToEvents(device) {
    if (!this.connected) return;

    if (!device.isSubscribed)
      debugEvent(`[${device.deviceId}] Subscribe device to receieve events`);

    const body = {
      action: 'set',
      properties: { devices: [device.deviceId] },
      resource: `subscriptions/${this.userId}`,
      publishResponse: false,
    };

    await this._notify(body, device);

    // Keep event stream open by subscribing base station every 20 seconds
    if (device.deviceType === TYPE_BASESTATION)
      setTimeout(() => this._subscribeToEvents.call(this, device), 20000);
  }

  /**
   * Subscribe devices to events
   */
  async _subscribeDevices() {
    // Base station
    await this._subscribeToEvents.call(this, this.baseStation);

    // Q Cameras
    const devices = this.cameras.filter(
      (d) => d.deviceType === TYPE_ARLOQS || d.deviceType === TYPE_ARLOQ,
    );
    if (devices.length === 0) return new Error('No Q device found');
    // eslint-disable-next-line no-restricted-syntax
    for (const device of devices) {
      this._subscribeToEvents.call(this, device);
    }
    return true;
  }

  /**
   * Get Arlo devices
   */
  async _getDevices() {
    debug('Getting devices');

    try {
      const url = ARLO_URLS.DEVICES_V2;
      const response = await this._get(url);
      if (response instanceof Error) {
        debug(response);
        return false;
      }
      const body = response.data;

      // Setup base station
      const baseStationData = body.filter(
        (d) => d.deviceType === TYPE_BASESTATION,
      );
      if (baseStationData.length === 0) {
        debug('No base station found');
        return false;
      }

      // Process base station data
      [this.baseStation] = baseStationData;
      this.userId = baseStationData[0].userId;

      debug(`Found base station: ${this.baseStation.deviceId}`);
      this.emit(EVENT_FOUND, {
        id: this.baseStation.deviceId,
        type: TYPE_BASESTATION,
        name: this.baseStation.deviceName,
      });

      this.cameras = [];
      // Process remaining devices
      body.forEach(async (device) => {
        // Camera
        if (device.deviceType === TYPE_CAMERA) {
          debug(`Found camera: ${device.deviceId}`);
          this.cameras.push(device);
          this.emit(EVENT_FOUND, {
            id: device.deviceId,
            type: TYPE_CAMERA,
            name: device.deviceName,
          });
        }

        // Arlo Q
        if (
          device.deviceType === TYPE_ARLOQS ||
          device.deviceType === TYPE_ARLOQ
        ) {
          debug(`Found Q camera: ${device.deviceId}`);
          this.cameras.push(device);
          this.emit(EVENT_FOUND, {
            id: device.deviceId,
            type: TYPE_ARLOQ,
            name: device.deviceName,
          });
        }
      });

      debug('Found all devices');
      this.emit(EVENT_GOT_DEVICES, this.cameras);
      await this._subscribeDevices.call(this);

      return true;
    } catch (err) {
      debug(err);
    }
    return true;
  }

  /**
   * Get devices and their properties
   */
  async _updateDevicesAndProperties() {
    const getDevices = await this._getDevices.call(this);
    if (!getDevices) {
      debugEvent('Unable to get all devices');
      this._fatal();
    }
    // Update Base station properties
    debugEvent(`[${this.baseStation.deviceId}] Request device properties`);
    this._requestDeviceEvents.call(this, this.baseStation);

    // Update Q Camera properties
    const devices = this.cameras.filter(
      (d) => d.deviceType === TYPE_ARLOQS || d.deviceType === TYPE_ARLOQ,
    );
    if (devices.length === 0) return new Error('No Q device found');
    // eslint-disable-next-line no-restricted-syntax
    for (const device of devices) {
      // eslint-disable-next-line no-await-in-loop
      debugEvent(`[${device.deviceId}] Request device properties`);
      this._requestDeviceEvents.call(this, device);
    }

    await this._getArmedStatus.call(this);
    this.emit(EVENT_PROPERTIES, {});

    return true;
  }

  /**
   * Process event messages
   */
  async _processEventMessage(eventData) {
    try {
      // Connect to event stream
      if (eventData.status === EVENT_CONNECTED) {
        debugEvent('Connected to event notification stream');
        this.connected = true;
        this.emit(EVENT_CONNECTED, eventData);

        // Get devices
        this._updateDevicesAndProperties.call(this);

        // Set interval for devices and properties refresh
        if (this.updatePropertiesTimer) {
          const timer = setInterval(async () => {
            this._updateDevicesAndProperties.call(this);
          }, this.updatePropertiesTimer);
          this.timers.push(timer);
        }
        return;
      }

      // Full frame snapshot event
      if (eventData.action === EVENT_FF_SNAPSHOT_AVAILABLE) {
        const deviceID = eventData.resource.substr(8);
        debugEvent(`[${deviceID}] New full frame snapshot available`);

        const { presignedFullFrameSnapshotUrl } = eventData.properties;

        // Update device
        const deviceIndex = this.cameras.findIndex(
          (d) => d.deviceId === deviceID,
        );
        this.cameras[deviceIndex].presignedFullFrameSnapshotUrl =
          presignedFullFrameSnapshotUrl;

        this.emit(EVENT_FF_SNAPSHOT_AVAILABLE, {
          id: deviceID,
          data: { presignedFullFrameSnapshotUrl },
        });
        return;
      }

      // Local storage open event
      if (eventData.resource === EVENT_RATLS) {
        debugEvent(
          `[${this.baseStation.deviceId}] Local storage open for 5 minutes`,
        );
        this.RATLS.ip = eventData.properties.privateIP;
        this.RATLS.port = eventData.properties.port;
        this.emit(EVENT_RATLS);
      }

      // Media upload event
      if (eventData.resource === EVENT_MEDIA_UPLOAD) {
        const deviceID = eventData.deviceId;
        debugEvent(`[${deviceID}] New media upload event`);
        const { presignedContentUrl } = eventData;
        const { presignedThumbnailUrl } = eventData;
        const { presignedLastImageUrl } = eventData;

        // Get device
        const deviceIndex = this.cameras.findIndex(
          (d) => d.deviceId === deviceID,
        );
        if (deviceIndex < 0) {
          debugEvent('No device found');
          return;
        }

        // If stream was active it's now finished
        if (this.cameras[deviceIndex].streamActive) {
          this.cameras[deviceIndex].streamActive = false;
          this.cameras[deviceIndex].streamURL = '';
        }

        // Update device image properties
        const rtnData = {};
        if (presignedContentUrl) {
          this.cameras[deviceIndex].presignedContentUrl = presignedContentUrl;
          rtnData.presignedContentUrl = presignedContentUrl;
        }
        if (presignedThumbnailUrl) {
          this.cameras[deviceIndex].presignedThumbnailUrl =
            presignedThumbnailUrl;
          rtnData.presignedThumbnailUrl = presignedThumbnailUrl;
        }
        if (presignedLastImageUrl) {
          this.cameras[deviceIndex].presignedLastImageUrl =
            presignedLastImageUrl;
          rtnData.presignedLastImageUrl = presignedLastImageUrl;
        }
        this.emit(EVENT_MEDIA_UPLOAD, {
          id: deviceID,
          data: rtnData,
        });
        return;
      }

      // Arm / disarm event
      if (eventData.resource === EVENT_MODE) {
        const id = Object.keys(eventData)[1];
        const description =
          eventData[id].activeModes[0] === 'mode0' ? 'disarmed' : 'armed';

        if (eventData[id].activeModes[0] === 'mode0')
          this.baseStation.armed = false;
        else this.baseStation.armed = true;

        debugEvent(`[${id}] Mode change event`);

        this.logger.info(
          `Base Station is ${
            !this.baseStation.armed ? 'dis' : ''
          }armed - Cam motion recording is ${
            this.baseStation.armed ? '' : 'not '
          }active`,
        );

        this.emit('mode', {
          id: Object.keys(eventData)[1],
          data: {
            mode: eventData[id].activeModes[0],
            description,
            armed: this.baseStation.armed,
          },
        });
      }

      // Q Cemera wifi event
      if (eventData.resource === 'wifi/ap') {
        const deviceID = eventData.from;
        debugEvent(`[${deviceID}] Wifi update event`);

        // Get device
        const deviceIndex = this.cameras.findIndex(
          (d) => d.deviceId === deviceID,
        );
        if (deviceIndex < 0) {
          debugEvent('No device found');
          return;
        }

        debugEvent(`[${deviceID}] Update wifi properties`);
        this.cameras[deviceIndex].wifi = eventData.properties;
        return;
      }

      // Other events
      if (eventData.action === 'is') {
        const subscription = /subscriptions\/(.+)$/;
        const siren = /siren\/(.+)$/;

        // Subscribed event
        if (subscription.test(eventData.resource)) {
          const deviceID = eventData.properties.devices[0];

          if (deviceID === this.baseStation.deviceId) {
            this.baseStation.isSubscribed = true;
          } else {
            const deviceIndex = this.cameras.findIndex(
              (d) => d.deviceId === deviceID,
            );
            if (deviceIndex < 0) {
              debugEvent('No device found');
              return;
            }
            this.cameras[deviceIndex].isSubscribed = true;
          }
          return;
        }

        // Siren state event
        if (siren.test(eventData.resource)) {
          const deviceID = eventData.resource.substring(6);
          debugEvent(`[${deviceID}] Update siren properties`);

          // Get device
          const deviceIndex = this.cameras.findIndex(
            (d) => d.deviceId === deviceID,
          );
          if (deviceIndex < 0) {
            debugEvent('No device found');
            return;
          }
          this.cameras[deviceIndex].siren = eventData.properties;
          this.emit(EVENT_SIREN, this.cameras[deviceIndex].siren);
          return;
        }

        // Smart hub devices update event
        if (eventData.resource === EVENT_DEVICES) {
          const { devices } = eventData;
          Object.keys(devices).forEach((deviceID) => {
            if (deviceID === this.baseStation.deviceId) {
              debugEvent(`[${deviceID}] Update base station properties`);
              this.baseStation.properties = devices[deviceID].properties;
            } else {
              const deviceIndex = this.cameras.findIndex(
                (d) => d.deviceId === deviceID,
              );
              if (deviceIndex < 0) {
                debugEvent('No device found');
                return false;
              }
              debugEvent(`[${deviceID}] Update camera properties`);
              this.cameras[deviceIndex].properties =
                devices[deviceID].properties;

              // Emit battery event
              this.emit(EVENT_BATTERY, {
                id: deviceID,
                data: {
                  batteryLevel:
                    this.cameras[deviceIndex].properties.batteryLevel,
                  chargingState:
                    this.cameras[deviceIndex].properties.chargingState,
                  signalStrength:
                    this.cameras[deviceIndex].properties.signalStrength,
                },
              });

              // Emit device updated event
              this.emit(EVENT_DEVICE_UPDATE, {
                id: deviceID,
                data: this.cameras[deviceIndex].properties,
              });
            }
            return true;
          });
          return;
        }

        // Q Camera base station event
        if (eventData.resource === 'basestation') {
          const deviceID = eventData.from;
          debugEvent(`[${deviceID}] Q base station update event`);

          // Get device
          const deviceIndex = this.cameras.findIndex(
            (d) => d.deviceId === deviceID,
          );
          if (deviceIndex < 0) {
            debugEvent('No device found');
            return;
          }

          debugEvent(`[${deviceID}] Update Q base station properties`);
          this.cameras[deviceIndex].baseStation = {};
          this.cameras[deviceIndex].baseStation.properties =
            eventData.properties;

          return;
        }

        // Q Camera event
        if (eventData.resource === 'cameras') {
          const deviceID = eventData.from;
          debugEvent(`[${deviceID}] Q device camera update event`);

          if (eventData.properties.length === 0) {
            debugEvent(`[${deviceID}] Not device properties in payload`);
            return;
          }

          // Get device
          const deviceIndex = this.cameras.findIndex(
            (d) => d.deviceId === deviceID,
          );
          if (deviceIndex < 0) {
            debugEvent('No device found');
            return;
          }

          debugEvent(`[${deviceID}] Update Q camera properties`);
          this.cameras[deviceIndex].properties = eventData.properties;

          // Emit device updated event
          this.emit(EVENT_DEVICE_UPDATE, {
            id: deviceID,
            data: this.cameras[deviceIndex].properties,
          });
        }
        return;
      }

      if (eventData.action === EVENT_LOGOUT) {
        debugEvent('Logged out by another session');
        await this._logOut.call(this);

        debugEvent('Wait 5 minutes then log back in');
        setTimeout(() => {
          this.login.call(this);
        }, 5 * 60000);
        return;
      }
      // debugEvent(eventData);
    } catch (e) {
      debugEvent(e);
      this.connected = false;
    }
  }

  /**
   * Subscribe to event stream
   */
  // eslint-disable-next-line class-methods-use-this
  _convertMessageToJson(data) {
    let newMessage;
    try {
      newMessage = `{${data.replace(
        /^event: message\s*data/,
        '"event": "message", "data"',
      )}}`;
      newMessage = newMessage.replace('“', '"');
      newMessage = JSON.parse(newMessage);
      return newMessage;
    } catch (err) {
      // debug('Unable to parse message');
      return err;
    }
  }

  async _subscribe() {
    debugEvent('Subscribe to event notifications');

    // Set headers
    this.subscribeHeaders = this.headers;
    this.subscribeHeaders.accept = 'text/event-stream';

    // Set cancel token
    const cancelToken = axios.CancelToken;
    this.subscribeCancelToken = cancelToken.source();

    await axios({
      url: ARLO_URLS.SUBSCRIBE,
      method: 'GET',
      jar: this.cookieJar,
      withCredentials: true,
      responseType: 'stream',
      headers: this.subscribeHeaders,
      cancelToken: this.subscribeCancelToken.token,
    })
      .then((response) => {
        this.headers.accept = 'application/json';
        let partMessage = '';
        response.data.on('data', (data) => {
          try {
            // debug(data.toString());

            partMessage += data.toString();
            const msg = this._convertMessageToJson(partMessage);

            // Check for multi-part event message
            if (msg instanceof Error || typeof msg === 'undefined') {
              // debug('Multi-part message');
              return;
            }
            partMessage = ''; // Reset
            this.emit(EVENT_MESSAGE, msg);
            this._processEventMessage.call(this, msg.data);
          } catch (err) {
            debugEvent(err);
          }
        });
        response.data.on('error', async (err) => {
          this.connected = false;
          if (err.message.includes('aborted')) {
            debugEvent('End of current event notification stream');
            if (this.loggedIn) {
              await this._subscribe.call(this);
              await this._subscribeDevices.call(this);
            }
          }
        });
        response.data.on('end', async () => {
          this.connected = false;
          debugEvent('End of current event notification stream');
          if (this.loggedIn) {
            await this._subscribe.call(this);
            await this._subscribeDevices.call(this);
          }
        });
      })
      .catch((err) => {
        debugEvent(err);
        this.headers.accept = 'application/json';
      });
  }

  /**
   * Get data from url
   */
  async _get(url) {
    try {
      const options = {
        method: 'GET',
        withCredentials: true,
        url,
        headers: this.headers,
      };
      const response = await this.axiosClient(options);
      return response.data;
    } catch (err) {
      debugComm(err.message);
      return err;
    }
  }

  /**
   * Post data to url
   */
  async _post(url, body, headers) {
    const options = {
      withCredentials: true,
      method: 'POST',
      headers: extend._extend(headers || {}, this.headers),
      url,
      data: body,
    };

    try {
      // const response = await cloudflareScraper(options);
      const response = await this.axiosClient(options);
      return response.data;
    } catch (err) {
      debugComm(err.message);
      return err;
    }
  }

  /**
   * Put data to url
   */
  async _put(url, body, headers) {
    try {
      const options = {
        method: 'PUT',
        withCredentials: true,
        url,
        headers: extend._extend(headers || {}, this.headers),
        data: body,
      };
      const response = await this.axiosClient(options);
      return response.data;
    } catch (err) {
      debugComm(err.message);
      return err;
    }
  }

  /**
   * Print the message to console and exit the process
   */
  // eslint-disable-next-line class-methods-use-this
  _fatal() {
    debug('Stopping service due to fatal error');
    process.exit(1);
  }
}

Arlo.EVENT_LOGGED_IN = EVENT_LOGGED_IN;
Arlo.EVENT_GOT_DEVICES = EVENT_GOT_DEVICES;
Arlo.EVENT_DEVICE_UPDATE = EVENT_DEVICE_UPDATE;
Arlo.EVENT_BATTERY = EVENT_BATTERY;
Arlo.EVENT_MEDIA_UPLOAD = EVENT_MEDIA_UPLOAD;
Arlo.EVENT_LOGOUT = EVENT_LOGOUT;
Arlo.EVENT_RATLS = EVENT_RATLS;
Arlo.EVENT_PROPERTIES = EVENT_PROPERTIES;

Arlo.TYPE_ARLOQS = 'arloqs';
Arlo.TYPE_ARLOQ = 'arloq';
Arlo.TYPE_BASESTATION = 'basestation';
Arlo.TYPE_CAMERA = 'camera';

export default Arlo;
