/**
 * Import libraries
 */
const imap = require('imap-simple');
const { htmlToText } = require('html-to-text');
const debug = require('debug')('Arlo:mfa');

const API_DOMAIN = 'myapi.arlo.com';
const URL_MFA_BASE = 'https://ocapi-app.arlo.com/api';
const AUTH_URLS = {
  MFA_START: `${URL_MFA_BASE}/startAuth`,
  GET_FACTORS: `${URL_MFA_BASE}/getFactors?data=`,
  GET_AUTH_TOKEN: `${URL_MFA_BASE}/auth?timestamp=`,
  SUBMIT_MFACODE: `${URL_MFA_BASE}/finishAuth`,
  VERIFY_AUTH: `${URL_MFA_BASE}/validateAccessToken?data=`,
  START_NEW_SESSION: `https://${API_DOMAIN}/hmsweb/users/session/v2`,
};

const auth = {};

/**
 * Private MFA functions
 */

// Get authorization token
async function _getAuthToken(email, password) {
  try {
    debug('Get auth token');
    const url = AUTH_URLS.GET_AUTH_TOKEN + new Date().getTime();
    const postBody = {
      email,
      password,
      languag: 'en',
      EnvSource: 'prod',
    };

    const response = await this._post(url, postBody);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.data.meta.message);
      return false;
    }

    if (!response.data.mfa) {
      debug('Account is not 2FA enabled');
      return false;
    }

    const { token } = response.data;
    const buff = Buffer.from(token);
    const tokenBase64 = buff.toString('base64');
    this.headers.Authorization = tokenBase64;
    auth.authenticated = response.data.authenticated;
    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

// Get mfa factors
async function _getFactors() {
  debug('Get factors');
  auth.userAuthToken = this.headers.Authorization;
  const url = AUTH_URLS.GET_FACTORS + auth.authenticated;

  const response = await this._get(url);
  if (response instanceof Error || typeof response === 'undefined') {
    debug(response);
    return false;
  }

  if (response.meta.code !== 200) {
    debug(response.data.meta.message);
    return false;
  }

  debug('Filter email factor');
  const factor = response.data.items.filter(
    (item) => item.factorType === 'EMAIL',
  );

  auth.factorID = factor[0].factorId;

  return true;
}

// Request 2fa token
async function _request2fa() {
  try {
    debug('Request 2fa email');
    const url = AUTH_URLS.MFA_START;
    const postBody = {
      factorId: auth.factorID,
    };
    const response = await this._post(url, postBody);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }
    auth.factorAuthCode = response.data.factorAuthCode;
    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

// Get 2fa code from email body
function _get2FACode(message) {
  debug('Get 2fa code');
  debug('Convert message body to string');
  const pureStr = message.replace(/\r?\n|\r/g, '');
  debug('Search for arlo mfa code in email body');
  const searchStr = 'Your Arlo one-time authentication code is:';
  const startPosition = pureStr.indexOf(searchStr) + searchStr.length;
  const mfaCode = pureStr.substr(startPosition, 6);
  debug('Got 2fa code');
  return mfaCode;
}

// Get arlo emails from server
function _getArloEmails(mailServer) {
  return new Promise((resolve, reject) => {
    const searchCriteria = [
      // ['HEADER', 'SUBJECT', 'Your one-time authentication code from Arlo'],
      'UNSEEN',
    ];
    const fetchOptions = {
      bodies: ['TEXT'],
      markSeen: true,
      struct: true,
    };

    const waitForEmail = 5000; // 5 seconds
    debug(`Wait ${waitForEmail / 1000} seconds for arlo mfa email to arrive`);
    setTimeout(async () => {
      debug('Check for arlo mfa email');
      mailServer
        .search(searchCriteria, fetchOptions)
        .then((messages) => resolve(messages))
        .catch((err) => reject(err));
    }, waitForEmail);
  });
}

// Login to email server
function _loginToEmailServer(emailServerConfig) {
  debug('Login to mail server');
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    const config = {
      imap: emailServerConfig,
    };

    debug('Connect to mail server');
    try {
      const mailServer = await imap.connect(config);

      debug('Open inbox');
      mailServer
        .openBox('INBOX')
        .then(() => resolve(mailServer))
        .catch((err) => reject(err));
    } catch (err) {
      debug(err.message);
      reject(err);
    }
  });
}

// Delete email
function _deleteEmail(mailServer, uid) {
  return new Promise((resolve, reject) => {
    debug('Delete arlo 2fa email');
    mailServer
      .deleteMessage([uid])
      .then(() => resolve(true))
      .catch((err) => reject(err));
  });
}

// Get 2fa code from email
async function _get2faCodeFromEmail(emailServerConfig) {
  try {
    debug('Get arlo mfa emails');
    const mailServer = await _loginToEmailServer(emailServerConfig);
    if (mailServer instanceof Error) {
      debug(mailServer.message);
      return false;
    }

    let messages = await _getArloEmails(mailServer);
    if (messages.length === 0) {
      debug('email not arrived, retry');
      messages = await _getArloEmails(mailServer);
    }
    if (messages.length === 0) {
      debug('email not arrived');
      return false;
    }

    const latestMessageID = messages.length - 1;
    const html = htmlToText(messages[latestMessageID].parts[0].body, {
      wordwrap: false,
    });
    auth.mfaCode = await _get2FACode(html);

    await _deleteEmail(mailServer, messages[latestMessageID].attributes.uid);

    debug('Close connection to mail server');
    await mailServer.closeBox(true, (err) => {
      if (err) debug(err);
    });
    mailServer.end();
    return true;
  } catch (err) {
    debug(err.massage);
    return false;
  }
}

// Submit 2fa token
async function _submit2faCode() {
  debug('Submit 2fa token');
  const url = AUTH_URLS.SUBMIT_MFACODE;
  const body = {
    factorAuthCode: auth.factorAuthCode,
    otp: auth.mfaCode,
  };
  const response = await this._post(url, body);
  if (response instanceof Error || typeof response === 'undefined') {
    debug(response);
    return false;
  }

  if (response.meta.code !== 200) {
    debug(response.meta.message);
    return false;
  }

  auth.token = response.data.token;
  const buff = Buffer.from(auth.token);
  const tokenBase64 = buff.toString('base64');
  this.headers.Authorization = tokenBase64;
  auth.tokenExpires = response.data.expiresIn;
  return true;
}

// Verifiy authorization token
async function _verifyAuthToken() {
  debug('Verifiy authorization token');
  try {
    const url = AUTH_URLS.VERIFY_AUTH + auth.authenticated;
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }

    this.userProfile = response.data;

    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

// New session
async function _newSession() {
  debug('Start new session');
  try {
    // Set headers
    this.headers.Accept = 'application/json';
    this.headers.Authorization = auth.token;
    this.headers.Host = API_DOMAIN;

    const url = AUTH_URLS.START_NEW_SESSION;
    const response = await this._get(url);

    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    this.token = response.data.token;
    this.userId = response.data.userId;
    this.serialNumber = response.data.serialNumber;
    this.sessionExpires = auth.tokenExpires;
    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

module.exports = {
  _getAuthToken,
  _getFactors,
  _request2fa,
  _get2faCodeFromEmail,
  _submit2faCode,
  _verifyAuthToken,
  _newSession,
};
