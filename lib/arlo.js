/**
 * Import libraries
 */
const axios = require('axios');
const extend = require('util')._extend;
const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const crypto = require('crypto');
const debug = require('debug')('Arlo:main');
const debugComm = require('debug')('Arlo:AXIOS');
const debugEvent = require('debug')('Arlo:event');

const mfa = require('./mfa');

// URL's
const ARLO_URLS = { ROOT: 'https://my.arlo.com' };
ARLO_URLS.API_ROOT = 'https://myapi.arlo.com';
ARLO_URLS.WEB = `${ARLO_URLS.API_ROOT}/hmsweb`;
ARLO_URLS.WEB_CLIENT = `${ARLO_URLS.WEB}/client`;
ARLO_URLS.SUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/subscribe`;
ARLO_URLS.UNSUBSCRIBE = `${ARLO_URLS.WEB_CLIENT}/unsubscribe`;
ARLO_URLS.DEVICES_V2 = `${ARLO_URLS.WEB}/v2/users/devices`;
ARLO_URLS.DEVICES = `${ARLO_URLS.WEB}/users/devices`;
ARLO_URLS.NOTIFY = `${ARLO_URLS.DEVICES}/notify`;
ARLO_URLS.STREAM = `${ARLO_URLS.DEVICES}/startStream`;

// Events
const EVENT_LOGGED_IN = 'logged_in';
const EVENT_MESSAGE = 'message';
const EVENT_CONNECTED = 'connected';
const EVENT_FF_SNAPSHOT_AVAILABLE = 'fullFrameSnapshotAvailable';
const EVENT_MEDIA_UPLOAD_NOTIFICATION = 'mediaUploadNotification';
const EVENT_FOUND = 'device_found';
const EVENT_GOT_DEVICES = 'got_all_devices';
const EVENT_MODE = 'activeAutomations';
const EVENT_DEVICES = 'devices';
// const EVENT_MOTION = 'motionDetected';
// const EVENT_AUDIO = 'audioDetected';
// const EVENT_BATTERY = 'batteryLevel';
// const EVENT_CHARGING = 'chargingState';
// const EVENT_UPDATE = 'update';

// Device Types
const TYPE_ARLOQS = 'arloqs';
const TYPE_ARLOQ = 'arloq';
const TYPE_BASESTATION = 'basestation';
const TYPE_CAMERA = 'camera';

// Default headers
const BASE_HEADERS = {
  origin: ARLO_URLS.ROOT,
  Referer: ARLO_URLS.ROOT,
  Accept: 'application/json, text/plain, */*',
  'Auth-Version': '2',
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 11_1_2 like Mac OS X) AppleWebKit/604.3.5 (KHTML, like Gecko) Mobile/15B202 NETGEAR/v1 (iOS Vuezone)',
  'Content-Type': 'application/json;charset=utf-8',
  schemaVersion: '1',
  Source: 'arloCamWeb',
};

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
   *    updateStateEvery (request device status in minutes),
   *  }
   */
  constructor(options) {
    super();

    if (!options) {
      debug('No options passed in');
      this._fatal();
    }
    this.config = options;

    this.connected = false;
    this.cameras = [];
    this.timers = {};
    const timerMinutes = options.updateStateEvery || 10;
    this.statusUpdateTimer = timerMinutes * 60000;
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

    this.headers = BASE_HEADERS;

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
    this.emit(EVENT_LOGGED_IN, this.serialNumber);

    this.headers = BASE_HEADERS;
    this.headers = extend({ Authorization: this.token }, this.headers);

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
  setPrivacyActive(deviceID, active) {
    debug(`[${deviceID}] Turn camera ${active ? 'on' : 'off'}`);
    const deviceIndex = this.cameras.findIndex(
      (d) => d.deviceId === deviceID,
    );
    if (deviceIndex < 0) {
      const err = new Error('No device found');
      debug(err);
      return err;
    }
    const device = this.cameras[deviceIndex];
    this._notify(
      {
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        properties: { privacyActive: active },
      },
      device,
    );
    return true;
  }

  /**
   * Turn on the siren
   */
  sirenOn(deviceID) {
    debug('Turn siren on');
    this._notify(
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
  }

  /**
   * Turn off the siren
   */
  sirenOff(deviceID) {
    debug('Turn siren off');
    this._notify(
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
  }

  /**
   * Start camera video stream
   */
  async startStream(deviceID) {
    try {
      const transID = uuid();
      const body = {
        from: `${this.userId}_web`,
        to: this.baseStation.deviceId,
        action: 'set',
        resource: `cameras/${deviceID}`,
        publishResponse: true,
        transId: transID,
        properties: {
          activityState: 'startUserStream',
          cameraId: deviceID,
        },
      };

      const url = ARLO_URLS.STREAM;
      const response = await this._post(url, body, {
        xCloudId: this.baseStation.xCloudId,
      });
      if (response instanceof Error || typeof response === 'undefined') {
        debug(response.message);
        return response;
      }

      const { data } = response;
      if (data.url === null || data.url === undefined) {
        const err = new Error(`Error getting stream for device: ${deviceID}`);
        debug(err.message);
        return err;
      }

      const rtnURL = data.url.replace('rtsp://', 'rtsps://');
      debug(`Got stream URL: ${rtnURL}`);
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
      debug('Return snapshot URL');
      const deviceIndex = this.cameras.findIndex(
        (d) => d.deviceId === deviceID,
      );
      if (deviceIndex < 0) {
        const err = new Error('No device found');
        debug(err);
        return err;
      }
      const url = this.cameras[deviceIndex].presignedLastImageUrl;
      return url;
    } catch (err) {
      debug(err);
      return err;
    }
  }

  /**
   * Request properties update of all cemeras
   */
  getCamStatus() {
    debug('Request device status refresh for all devices');

    // Request base station update
    this._subscribeToEvents.call(this, this.baseStation);

    // Request Q cameras update
    const devices = this.cameras.filter(
      (d) => d.deviceType === TYPE_ARLOQS || d.deviceType === TYPE_ARLOQ,
    );
    devices.forEach((device) => {
      this._subscribeToEvents.call(this, device);
    });

    return true;
  }

  /** *************************
   * Private functions
   ************************* */

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
   * Send notify requests to Arlo back end
   */
  async _notify(body, device) {
    try {
      const postBody = body;
      postBody.from = `${this.userId}_web`;
      postBody.to = device.deviceId;
      postBody.transId = this._genTransID();

      // Set url
      const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}`;

      // Issue request
      const response = await this._post(url, postBody, {
        xCloudId: device.xCloudId,
      });

      if (response instanceof Error || typeof response === 'undefined') {
        debug(response);
        return response;
      }

      if (response.sucess === false) debug(response);
    } catch (err) {
      debug(err);
    }
    return true;
  }

  /**
   * Request device events
   */
  async _requestDeviceEvents(device) {
    if (device.deviceType === TYPE_ARLOQS || device.deviceType === TYPE_ARLOQ) {
      debug('Setup Q camera event notifications');
      try {
        debug(`[${device.deviceId}] Event: State`);
        await this._notify(
          {
            action: 'get',
            resource: `devices/${device.deviceId}/states`,
            publishResponse: false,
          },
          device,
        );

        debug(`[${device.deviceId}] Event: Siren`);
        await this._notify(
          {
            action: 'get',
            resource: `siren/${device.deviceId}`,
            publishResponse: false,
          },
          device,
        );

        debug(`[${device.deviceId}] Event: Multipul requests`);
        const from = `${this.userId}_web`;
        const to = device.deviceId;
        const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}`;
        const body = [
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
            resource: 'modes',
            transId: this._genTransID(),
            publishResponse: false,
          },
          {
            from,
            to,
            action: 'get',
            resource: 'rules',
            transId: this._genTransID(),
            publishResponse: false,
          },
          {
            from,
            to,
            action: 'get',
            resource: 'schedule',
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

        // Issue request
        const response = await this._post(url, body, {
          xCloudId: device.xCloudId,
        });
        if (response instanceof Error || typeof response === 'undefined')
          debug(response);
        if (response.sucess === false) debug(response);
      } catch (err) {
        debug(err);
      }
    }

    if (device.deviceType === TYPE_CAMERA) {
      debug('Setup camera event notifications');
      try {
        debug(`[${device.deviceId}] Event: Siren`);
        this._notify(
          {
            action: 'get',
            resource: `siren/${device.deviceId}`,
            publishResponse: false,
          },
          device,
        );

        debug(`[${device.deviceId}] Event: State`);
        this._notify(
          {
            action: 'get',
            resource: `devices/${device.deviceId}/state`,
            publishResponse: false,
          },
          device,
        );
      } catch (err) {
        debug(err);
      }
    }

    if (device.deviceType === TYPE_BASESTATION) {
      debug(`[${device.deviceId}] Registered, now request event notifications`);
      try {
        const from = `${this.userId}_web`;
        const to = device.deviceId;
        const body = [
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
          body.push(
            {
              from,
              to,
              action: 'get',
              resource: `siren/${c.deviceId}`,
              transId: this._genTransID(),
              publishResponse: false,
            },
            {
              from,
              to,
              action: 'get',
              resource: `cameras/${c.deviceId}/motionZones`,
              transId: this._genTransID(),
              publishResponse: false,
            },
          );
          return true;
        });

        // Issue request
        const url = `${ARLO_URLS.NOTIFY}/${device.deviceId}`;
        const response = await this._post(url, body, {
          xCloudId: device.xCloudId,
        });
        if (response instanceof Error || typeof response === 'undefined')
          debug(response);
        if (response.sucess === false) debug(response);
      } catch (err) {
        debug(err);
      }
    }

    return true;
  }

  /**
   * Subscribe to events
   */
  _subscribeToEvents(device) {
    debug(`[${device.deviceId}] Subscribe to events`);
    this._notify(
      {
        action: 'set',
        properties: { devices: [device.deviceId] },
        resource: `subscriptions/${this.userId}_web`,
        publishResponse: false,
      },
      device,
    );
  }

  _subscribeDevices() {
    // Base station
    debug(`[${this.baseStation.deviceId}] Adding subscribe to events timer`);
    this._subscribeToEvents.call(this, this.baseStation);
    this.timers[`sub_${this.baseStation.deviceId}`] = setInterval(() => {
      if (!this.connected) return;
      if (this.baseStation.isSubscribed) {
        debug(
          `[${this.baseStation.deviceId}] Clearing subscribe to events timer`,
        );
        clearInterval(this.timers[`sub_${this.baseStation.deviceId}`]);
        return;
      }
      this._subscribeToEvents.call(this, this.baseStation);
    }, 30000);

    // Q Cameras
    const devices = this.cameras.filter(
      (d) => d.deviceType === TYPE_ARLOQS || d.deviceType === TYPE_ARLOQ,
    );

    if (devices.length === 0) return new Error('No device found');

    devices.forEach((device) => {
      if (
        !device.isSubscribed &&
        typeof this.timers[device.deviceId] === 'undefined'
      ) {
        debug(`[${device.deviceId}] Adding subscribe to events timer`);
        this._subscribeToEvents.call(this, device);
        this.timers[`sub_${device.deviceId}`] = setInterval(() => {
          let classDevice = this.cameras.filter(
            (d) => d.deviceId === device.deviceId,
          );
          [classDevice] = classDevice;
          if (classDevice.isSubscribed) {
            debug(`[${device.deviceId}] Clearing subscribe timer`);
            clearInterval(this.timers[`sub_${device.deviceId}`]);
            return;
          }
          this._subscribeToEvents.call(this, device);
        }, 30000);
      }
    });
    return true;
  }

  /**
   * Get Arlo devices
   */
  async _getDevices() {
    debug('Getting devices');

    const url = ARLO_URLS.DEVICES_V2;
    const response = await this._get(url, {});
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
    this._subscribeDevices.call(this);
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
        this.emit(EVENT_CONNECTED, eventData);
        this.connected = true;

        // Get devices if they do not exist
        if (this.cameras.length === 0) {
          const success = await this._getDevices.call(this);
          if (!success) {
            debugEvent('Unable to get all devices');
            this._fatal();
          }
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
      if (eventData.resource === EVENT_MEDIA_UPLOAD_NOTIFICATION) {
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
        this.emit(EVENT_MEDIA_UPLOAD_NOTIFICATION, {
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

      // Update events
      if (eventData.action === 'is') {
        const subscription = /subscriptions\/(.+)$/;

        // Subscribed event
        if (subscription.test(eventData.resource)) {
          const deviceID = eventData.properties.devices[0];

          if (deviceID === this.baseStation.deviceId) {
            this.baseStation.isSubscribed = true;
            this._requestDeviceEvents(this.baseStation);

            // Get status every few minutes
            this.timers[`stat_${deviceID}`] = setInterval(() => {
              this._requestDeviceEvents(this.baseStation);
            }, this.statusUpdateTimer);
          } else {
            const deviceIndex = this.cameras.findIndex(
              (d) => d.deviceId === deviceID,
            );
            if (deviceIndex < 0) {
              debugEvent('No device found');
              return;
            }
            this.cameras[deviceIndex].isSubscribed = true;
            this._requestDeviceEvents(this.cameras[deviceIndex]);

            // Get status every few minutes
            this.timers[`stat_${deviceID}`] = setInterval(() => {
              this._requestDeviceEvents(this.cameras[deviceIndex]);
            }, this.statusUpdateTimer);
          }
          debugEvent(`[${deviceID}] Subscribed to events`);
          return;
        }

        // Devices event
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
            }
            return true;
          });
          this.emit(EVENT_DEVICES, this.cameras);
        }

        // Q Camera event
        if (eventData.resource === 'cameras') {
          const deviceID = eventData.properties[0].serialNumber;
          debugEvent(`[${deviceID}] Device status update event`);

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

          debugEvent(`[${deviceID}] Update camera properties`);
          this.cameras[deviceIndex].properties = eventData.properties;
          this.emit(EVENT_DEVICES, this.cameras);
        }
      }
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
      debug('Unable to parse message');
      return err;
    }
  }

  async _subscribe() {
    debug('Subscribe to event notifications');
    axios({
      url: `${ARLO_URLS.SUBSCRIBE}?token=${this.token}`,
      method: 'GET',
      jar: true,
      responseType: 'stream',
      headers: extend({ Accept: 'text/event-stream' }, this.headers),
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
              debug('Multi-part message');
              return;
            }
            partMessage = ''; // Reset
            this.emit(EVENT_MESSAGE, msg);
            this._processEventMessage.call(this, msg.data);
          } catch (err) {
            debug(err);
          }
        });
        response.data.on('error', (err) => {
          this.connected = false;
          if (err.message.includes('aborted')) {
            debug('End of current event notification stream');
            this._subscribe();
          }
        });
        response.data.on('end', () => {
          this.connected = false;
          debug('End of current event notification stream');
          this._subscribe();
        });
      })
      .catch((err) => {
        debug(err);
      });
  }

  /**
   * Get data from url
   */
  async _get(url, headers, noHeaders) {
    try {
      let getHeaders = extend(headers || {}, this.headers);
      if (noHeaders) getHeaders = null;

      const options = {
        method: 'GET',
        url,
        headers: getHeaders,
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
Arlo.EVENT_DEVICES = EVENT_DEVICES;
Arlo.EVENT_MEDIA_UPLOAD_NOTIFICATION = EVENT_MEDIA_UPLOAD_NOTIFICATION;

module.exports = Arlo;
