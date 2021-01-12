/**
 * Import libraries
 */
const axios = require('axios');
const extend = require('util')._extend;
const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const tough = require('tough-cookie');
const axiosCookieJarSupport = require('axios-cookiejar-support').default;
const debug = require('debug')('Arlo:main');
const debugComm = require('debug')('Arlo:AXIOS');
const debugEvent = require('debug')('Arlo:event');

const mfa = require('./mfa');

// URL's
const ARLO_OCIPI_DOMAIN = 'ocapi-app.arlo.com';
const ARLO_DOMAIN = 'https://my.arlo.com';
const API_DOMAIN = 'myapi.arlo.com';
const ARLO_URLS = {};
ARLO_URLS.API_ROOT = `https://${API_DOMAIN}`;
ARLO_URLS.WEB = `${ARLO_URLS.API_ROOT}/hmsweb`;
ARLO_URLS.WEB_CLIENT = `${ARLO_URLS.WEB}/client`;
ARLO_URLS.SUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/subscribe`;
ARLO_URLS.UNSUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/unsubscribe`;
ARLO_URLS.WEB_USERS = `${ARLO_URLS.WEB}/users`;
ARLO_URLS.DEVICES_V2 = `${ARLO_URLS.WEB}/v2/users/devices`;
ARLO_URLS.DEVICES = `${ARLO_URLS.WEB_USERS}/devices`;
ARLO_URLS.AUTOMATIONACTIVE = `${ARLO_URLS.DEVICES}/automation/active`;
ARLO_URLS.SERVICE_LEVEL_SETTINGS = `${ARLO_URLS.WEB_USERS}/serviceLevel/settings`;
ARLO_URLS.SERVICE_LEVELS = `${ARLO_URLS.WEB_USERS}/serviceLevel/v4`;
ARLO_URLS.CAPABILITIES = `${ARLO_URLS.WEB_USERS}/capabilities`;
ARLO_URLS.FEATURES = `${ARLO_URLS.WEB_USERS}/subscription/smart/features`;
ARLO_URLS.EMERGENCY_LOCATIONS = `${ARLO_URLS.WEB_USERS}/emergency/locations`;
ARLO_URLS.NOTIFY = `${ARLO_URLS.DEVICES}/notify`;
ARLO_URLS.STREAM = `${ARLO_URLS.DEVICES}/startStream`;
ARLO_URLS.SNAPSHOT = `${ARLO_URLS.DEVICES}/fullFrameSnapshot`;

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

// ** TO DO **
// const EVENT_MOTION = 'motionDetected';
// const EVENT_AUDIO = 'audioDetected';
// const EVENT_CHARGING = 'chargingState';

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
   * Example = {
   *    arloUser (email address),
   *    arloPassword (password),
   *    emailUser (email address where mfa is sent),
   *    emailPassword (email password),
   *    emailServer (ip or domain name),
   *    updatePropertiesEvery (update device properties: in minutes),
   *  }
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

    // Set device properties pooling interval
    if (typeof options.updatePropertiesEvery !== 'undefined')
      this.updatePropertiesTimer = options.updatePropertiesEvery * 60000;

    axiosCookieJarSupport(axios);
    this.cookieJar = new tough.CookieJar();
  }

  /** *************************
   * Public functions
   ************************* */

  /**
   * Login to Arlo
   */
  async login() {
    const emailServerConfig = {
      // IMAP connection config
      user: this.config.emailUser,
      password: this.config.emailPassword,
      host: this.config.emailServer,
      port: 993,
      tls: true,
      tlsOptions: {
        rejectUnauthorized: false,
      },
    };

    this.headers = {
      Accept: 'application/json, text/plain, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Auth-Version': 2,
      Connection: 'keep-alive',
      Host: ARLO_OCIPI_DOMAIN,
      Origin: ARLO_DOMAIN,
      Referer: ARLO_DOMAIN,
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 11_1_2 like Mac OS X) AppleWebKit/604.3.5 (KHTML, like Gecko) Mobile/15B202 NETGEAR/v1 (iOS Vuezone)',
    };

    debug('Logging in to Arlo');
    let proceed = await mfa._getAuthToken.call(
      this,
      this.config.arloUser,
      this.config.arloPassword,
    );
    if (!proceed) return false;

    proceed = await mfa._getFactors.call(this);
    if (!proceed) return false;

    proceed = await mfa._request2fa.call(this);
    if (!proceed) return false;

    proceed = await mfa._get2faCodeFromEmail.call(this, emailServerConfig);
    if (!proceed) return false;

    proceed = await mfa._submit2faCode.call(this);
    if (!proceed) return false;

    proceed = await mfa._verifyAuthToken.call(this);
    if (!proceed) return false;

    proceed = await mfa._newSession.call(this);
    if (!proceed) return false;

    debug('Logged in');
    this.loggedIn = true;
    this.emit(EVENT_LOGGED_IN, this.serialNumber);

    // Set headers
    this.headers.Accept = 'application/json';
    this.headers['Content-Type'] = 'application/json; charset=utf-8';
    this.headers.Authorization = this.token;

    // Setup event stream listner
    await this._subscribe();

    return true;
  }

  /**
   * Arm base station/camera
   */
  arm(deviceID) {
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
  }

  /**
   * Disarm base station/camera
   */
  disarm(deviceID) {
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

      // Do not start stream if app just launched
      if (typeof device.properties.privacyActive === 'undefined') return false;

      // Do not start stream if camera is in privacy mode
      if (device.properties.privacyActive) {
        const err = new Error('Camera not active, unable to start stream');
        debug(`[${deviceID}] ${err}`);
        return err;
      }

      debug(`[${deviceID}] Camera is on, requesting stream`);
      const body = {
        from: `${this.userId}_web`,
        to: this.baseStation.deviceId,
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        transId: this._genTransID(),
        properties: {
          activityState: 'startUserStream',
          cameraId: deviceID,
        },
      };

      // Set headers
      this.headers['x-transaction-id'] = `FE!${uuid()}`;

      const url = ARLO_URLS.STREAM;
      const response = await this._post(url, body, {
        xCloudId: this.baseStation.xCloudId,
      });

      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      // Request device properties refresh
      await this._refreshDeviceProperties(deviceID);

      const { data } = response;

      if (data.url === null || typeof data.url === 'undefined') {
        const err = new Error(`Error getting stream for device: ${deviceID}`);
        debug(err.message);
        return err;
      }

      const rtnURL = data.url.replace('rtsp://', 'rtsps://');
      debug(`[${deviceID}] Stream URL: ${rtnURL}`);
      return rtnURL;
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
        presignedFullFrameSnapshotUrl: this.cameras[deviceIndex]
          .presignedFullFrameSnapshotUrl,
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
      body.from = `${this.userId}_web`;
      body.to = this.baseStation.deviceId;
      body.transId = this._genTransID();
      body.resource = `cameras/${deviceID}`;
      body.action = 'set';
      body.publishResponse = true;
      body.properties = { activityState: 'fullFrameSnapshot' };

      const xTransID = `FE!${uuid()}&time=${Date.now()}`;
      this.headers['x-transaction-id'] = xTransID;

      const response = await this._post(url, body, {
        xCloudId: device.xCloudId,
      });
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      if (!response.success) debug('Error getting FF snapshot');

      return true;
    } catch (err) {
      debug(err);
      return err;
    }
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
   * Get automation active data from api
   */
  async getAutomationActive() {
    debug('Getting automation active data');
    try {
      const url = ARLO_URLS.AUTOMATIONACTIVE;
      const response = await this._get(url);
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;

      if (data.length === 0) {
        const err = new Error(`Error getting automation active settings`);
        debug(err.message);
        return err;
      }

      return data;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Get service level settings from api
   */
  async getServiceLevelSettings() {
    debug('Getting service level settings data');
    try {
      const url = ARLO_URLS.SERVICE_LEVEL_SETTINGS;
      const response = await this._get(url);
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;

      if (data.length === 0) {
        const err = new Error(`Error getting service level settings`);
        debug(err.message);
        return err;
      }

      return data;
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
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;

      if (data.length === 0) {
        const err = new Error(`Error getting capabilities`);
        debug(err.message);
        return err;
      }

      return data;
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
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;

      if (data.length === 0) {
        const err = new Error(`Error getting features`);
        debug(err.message);
        return err;
      }

      return data;
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
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response);
      }
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
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;

      if (data.length === 0) {
        const err = new Error(`Error getting service levels`);
        debug(err.message);
        return err;
      }

      return data;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /** *************************
   * Private functions
   ************************* */

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
    const trandsID = `web!${id1}.${id2}!${Date.now()}`;
    return trandsID;
  }

  /**
   * Send notify requests to Arlo api
   */
  async _notify(body, device) {
    try {
      if (!this.connected) return;

      const eventId = `FE!${uuid()}`;

      // Set headers
      this.headers.Accept = 'application/json';
      this.headers['Content-Type'] = 'application/json; charset=utf-8';
      this.headers.timeout = 30000;
      this.headers['x-transaction-id'] = `FE!${uuid()}`;

      const postBody = body;
      postBody.from = `${this.userId}_web`;
      postBody.to = device.deviceId;
      postBody.transId = this._genTransID();

      // Set url
      const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}?eventId=${eventId}`;

      // debugEvent(url);
      // debugEvent(postBody);

      // Issue request
      const response = await this._post(url, postBody, {
        xCloudId: device.xCloudId,
      });

      if (response instanceof Error || typeof response === 'undefined') {
        debugEvent(response);
        return;
      }

      if (response.sucess === false) debugEvent(response);
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
        const from = `${this.userId}_web`;
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
        const from = `${this.userId}_web`;
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
      if (response instanceof Error || typeof response === 'undefined')
        debugEvent(response);
      if (response.sucess === false) debugEvent(response);
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

    await this._notify(
      {
        action: 'set',
        properties: { devices: [device.deviceId] },
        resource: `subscriptions/${this.userId}_web`,
        publishResponse: false,
      },
      device,
    );

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
      // eslint-disable-next-line no-await-in-loop
      await this._subscribeToEvents.call(this, device);
    }
    return true;
  }

  /**
   * Get Arlo devices
   */
  async _getDevices() {
    debug('Getting devices');

    const url = ARLO_URLS.DEVICES_V2;

    this.headers.Accept = '*/*';
    this.headers['Access-Control-Request-Headers'] =
      'auth-version,authorization,content-type,x-transaction-id';
    delete this.headers['Content-Type'];

    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }
    const body = response.data;
    if (body.success === false) {
      debug(body);
      return false;
    }

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
    debug(`Found base station: ${this.baseStation.deviceId}`);
    this.emit(EVENT_FOUND, {
      type: TYPE_BASESTATION,
      id: this.baseStation.deviceId,
      name: this.baseStation.deviceName,
    });

    this.cameras = [];
    // Process remaining devices
    body.forEach(async (device) => {
      // Camera
      if (device.deviceType === TYPE_CAMERA) {
        this.cameras.push(device);
        debug(`Found camera: ${device.deviceId}`);
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
        this.cameras.push(device);
        debug(`Found Q camera: ${device.deviceId}`);
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
        this.cameras[
          deviceIndex
        ].presignedFullFrameSnapshotUrl = presignedFullFrameSnapshotUrl;

        this.emit(EVENT_FF_SNAPSHOT_AVAILABLE, {
          id: deviceID,
          data: { presignedFullFrameSnapshotUrl },
        });
        return;
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

        // Update device
        const rtnData = {};
        if (presignedContentUrl) {
          this.cameras[deviceIndex].presignedContentUrl = presignedContentUrl;
          rtnData.presignedContentUrl = presignedContentUrl;
        }
        if (presignedThumbnailUrl) {
          this.cameras[
            deviceIndex
          ].presignedThumbnailUrl = presignedThumbnailUrl;
          rtnData.presignedThumbnailUrl = presignedThumbnailUrl;
        }
        if (presignedLastImageUrl) {
          this.cameras[
            deviceIndex
          ].presignedLastImageUrl = presignedLastImageUrl;
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
        const mode =
          eventData[id].activeModes[0] === 'mode0' ? 'disarmed' : 'armed';
        debugEvent(`[${id}] Mode change event`);
        this.emit('mode', {
          id: Object.keys(eventData)[1],
          data: mode,
        });
        return;
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
                  batteryLevel: this.cameras[deviceIndex].properties
                    .batteryLevel,
                  chargingState: this.cameras[deviceIndex].properties
                    .chargingState,
                  signalStrength: this.cameras[deviceIndex].properties
                    .signalStrength,
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
        this.connected = false;
        this.loggedIn = false;

        // Remove pooling timers
        this.timers.forEach((timer) => clearTimeout(timer));

        // Clear headers
        this.headers = {};
        this.subscribeHeaders = {};

        // End device event stream
        this.subscribeCancelToken.cancel('Logged out of arlo so cancel stream');

        // Emit logged out event
        this.emit(EVENT_LOGOUT, {});

        return;
      }
      debugEvent(eventData);
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
    if (!this.subscribeHeaders) {
      this.subscribeHeaders = this.headers;
      this.subscribeHeaders.Accept = 'text/event-stream';
    }

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
      });
  }

  /**
   * Get data from url
   */
  async _get(url) {
    try {
      const options = {
        method: 'GET',
        jar: this.cookieJar,
        withCredentials: true,
        url,
        headers: this.headers,
      };
      const response = await axios(options);
      return response.data;
    } catch (err) {
      if (err.response) {
        debugComm('Request made and server responded');
        debugComm(err.message);
        debugComm(err.response.data);
        debugComm(err.response.status);
      } else if (err.request) {
        debugComm('The request was made but no response was received');
        debugComm(err.request);
      } else {
        debugComm(
          'Something happened in setting up the request that triggered an Error',
        );
        debugComm(`Error: ${err.message}`);
      }
      return err;
    }
  }

  /**
   * Post data to url
   */
  async _post(url, body, headers) {
    try {
      const options = {
        method: 'POST',
        jar: this.cookieJar,
        withCredentials: true,
        url,
        headers: extend(headers || {}, this.headers),
        data: body,
      };
      const response = await axios(options);
      return response.data;
    } catch (err) {
      if (err.response) {
        debugComm('Request made and server responded');
        debugComm(err.message);
        debugComm(err.response.data);
        debugComm(err.response.status);
      } else if (err.request) {
        debugComm('The request was made but no response was received');
        debugComm(err.request);
      } else {
        debugComm(
          'Something happened in setting up the request that triggered an Error',
        );
        debugComm(err.message);
      }
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

module.exports = Arlo;
