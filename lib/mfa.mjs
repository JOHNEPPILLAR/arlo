/**
 * Import libraries
 */
import DebugModule from 'debug';
import Imap from 'imap';
import Mailparser from 'mailparser';
// eslint-disable-next-line import/no-unresolved
import { setTimeout } from 'timers/promises';

const { simpleParser } = Mailparser;
const debug = new DebugModule('Arlo:mfa');
const URL_MFA_BASE_MFA = 'https://ocapi-app.arlo.com/api';
const URL_MFA_BASE_MOBILE = `${URL_MFA_BASE_MFA}/v2`;

const AUTH_URLS_MOBILE = {
  VALID_TOKEN: `${URL_MFA_BASE_MOBILE}/ocAccessTokenValidate_PHP_MFA`,
  GET_AUTH_TOKEN: `${URL_MFA_BASE_MOBILE}/ocAuth_PHP_MFA`,
  GET_FACTORS: `${URL_MFA_BASE_MOBILE}/ocGetFactors_PHP_MFA`,
  REQUEST_MFA_CODE: `${URL_MFA_BASE_MOBILE}/ocStart2FAauth_PHP_MFA`,
};

const AUTH_URLS_MFA = {
  GET_AUTH_TOKEN: `${URL_MFA_BASE_MFA}/auth`,
  GET_FACTORS: `${URL_MFA_BASE_MFA}/getFactors?data=`,
  REQUEST_MFA_CODE: `${URL_MFA_BASE_MFA}/startAuth`,
  SUBMIT_MFACODE: `${URL_MFA_BASE_MFA}/finishAuth`,
  VERIFY_AUTH: `${URL_MFA_BASE_MFA}/validateAccessToken?data=`,
  START_NEW_SESSION: `https://myapi.arlo.com/hmsweb/users/session/v2`,
};

const auth = {};

// Validate authorization token
async function _validateToken() {
  try {
    const url = this.config.mfa
      ? AUTH_URLS_MFA.VALID_TOKEN
      : AUTH_URLS_MOBILE.VALID_TOKEN;
    const response = await this._get(url);

    if (response instanceof Error || typeof response === 'undefined') {
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }

    if (!response.data.tokenValidated) {
      debug('Token not validated');
      return false;
    }

    return true;
  } catch (err) {
    debug(err.message);
    return err;
  }
}

// Get authorization token
async function _getAuthToken() {
  try {
    debug('Get auth token');
    const url = this.config.mfa
      ? AUTH_URLS_MFA.GET_AUTH_TOKEN
      : AUTH_URLS_MOBILE.GET_AUTH_TOKEN;
    const postBody = {
      email: this.config.arloUser,
      password: this.config.arloPassword,
      language: 'en',
      EnvSource: 'prod',
    };

    const response = await this._post(url, postBody);

    if (response instanceof Error || typeof response === 'undefined') {
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }

    if (!response.data.mfa) {
      debug('Account is not MFA enabled');
      return false;
    }
    const { token } = response.data;
    const buff = Buffer.from(token);
    const tokenBase64 = buff.toString('base64');
    this.headers.authorization = tokenBase64;
    auth.authenticated = response.data.authenticated;
    auth.userID = response.data.userId;

    this.headers.accessToken = response.data.token;

    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

// Get mfa factors
async function _getFactors() {
  try {
    debug('Get factors');

    const url = this.config.mfa
      ? AUTH_URLS_MFA.GET_FACTORS + auth.authenticated
      : AUTH_URLS_MOBILE.GET_FACTORS;
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }

    const mfaType = this.config.mfa ? 'EMAIL' : 'PUSH';
    debug(`Filter factors to get ${mfaType}`);

    const factor = response.data.items.filter(
      (item) => item.factorType === mfaType
    );

    if (factor.length < 1) {
      debug('No mfa found');
      return false;
    }

    debug(`Found ${factor[0].factorType} factor`);
    auth.factorID = factor[0].factorId;
    auth.applicationID = factor[0].applicationId;

    return true;
  } catch (err) {
    debug(err.message);
    return err;
  }
}

// Request MFA code
async function _requestMFACode() {
  try {
    debug('Request MFA code');

    const url = this.config.mfa
      ? AUTH_URLS_MFA.REQUEST_MFA_CODE
      : `${AUTH_URLS_MOBILE.REQUEST_MFA_CODE}?applicationId=${auth.applicationID}`;
    const postBody = {
      factorId: auth.factorID,
      factorType: '',
      userId: auth.userID,
    };
    if (!this.config.mfa) postBody.mobilePayload = this.mobilePayload;

    const response = await this._post(url, postBody);

    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (!Object.keys(response).length) {
      debug('Reqiest MFA Code returned empty');
      return false;
    }

    if (response.meta.code !== 200) {
      debug(response.meta.message);
      return false;
    }

    if (this.config.mfa) {
      auth.factorAuthCode = response.data.factorAuthCode;
    } else {
      this.token = response.data.accessToken.token;
      this.tokenExpires = response.data.accessToken.expiredIn;
      this.headers.accessToken = this.token;
    }

    return true;
  } catch (err) {
    debug(err.message);
    return err;
  }
}

// Delete Arlo MFA email
function _deleteEmail(mailServer, uids) {
  return new Promise((resolve, reject) => {
    debug('Delete arlo MFA email');

    uids.forEach((uid) => {
      mailServer.addFlags(uid, 'Deleted', (err) => {
        if (err) reject(err);
      });
    });

    mailServer.expunge((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(true);
    });
  });
}

function _getMFACode(message) {
  return new Promise((resolve, reject) => {
    try {
      debug('Find MFA code in html');
      const searchArray = message.match(/\d{6}/);

      if (searchArray.length === 0) throw Error('No MFA code found in email');

      [auth.MFACode] = searchArray;
      debug(`Found MFA code: ${auth.MFACode}`);
      resolve(true);
    } catch (err) {
      debug(err);
      reject(err);
    }
  });
}

function _fetchEmail(mailServer, uid) {
  return new Promise((resolve, reject) => {
    const fetchOptions = {
      bodies: ['TEXT'],
      markSeen: true,
      struct: true,
    };
    const fetch = mailServer.fetch(uid, fetchOptions);

    function fetchOnMessage(message) {
      message.on('body', async (stream) => {
        debug('Convert email to html');
        try {
          const email = await simpleParser(stream);
          resolve(email.textAsHtml);
        } catch (err) {
          reject(err);
        }
      });
    }

    function fetchOnError(err) {
      debug(err.message);
      reject(err);
    }

    function removeListeners() {
      fetch.removeListener('message', fetchOnMessage);
      fetch.removeListener('error', fetchOnError);
    }

    fetch.on('message', fetchOnMessage);
    fetch.once('error', fetchOnError);
    fetch.once('end', removeListeners);
  });
}

function _searchInbox(mailServer) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    const searchCriteria = [
      ['SUBJECT', 'Your one-time authentication code from Arlo'],
    ];

    debug('Search inbox for MFA email');
    // eslint-disable-next-line no-await-in-loop
    mailServer.search(searchCriteria, (err, uids) => {
      if (err) {
        reject(err);
        return;
      }

      // Reject if no email found
      if (!uids || !uids.length) {
        debug('No email with Arlo MFA found');
        resolve([]);
        return;
      }

      // Found email, mark as read
      mailServer.setFlags(uids, ['\\Seen'], (setErr) => {
        if (setErr) debug(setErr);
        else debug('Marked message as read');
      });

      resolve(uids);
    });
  });
}

function _searchForEmail(mailServer, retry = 1) {
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve, reject) => {
    let uids;
    for (let i = 1; i <= retry; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        uids = await _searchInbox(mailServer);
        if (uids.length === 0) {
          debug('Waiting before retry search');
          // eslint-disable-next-line no-await-in-loop
          await setTimeout(5000);
        } else {
          break;
        }
      } catch (err) {
        debug(err);
        reject(err);
      }
    }

    if (uids.length === 0) {
      reject(new Error('Timed out searching for Arlo MFA email'));
      return;
    }
    resolve(uids);
  });
}

async function _openInbox(mailServer) {
  return new Promise((resolve) => {
    mailServer.openBox('INBOX', false, (err) => {
      if (err) {
        debug(err.message);
        resolve(false);
      }
      resolve(true);
    });
  });
}

async function _getMFACodeFromEmail() {
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
  debug('Connect to imap server');

  return new Promise((resolve) => {
    try {
      const mailServer = new Imap(emailServerConfig);

      mailServer.once('error', (err) => {
        debug(err);
        resolve(false);
      });

      mailServer.once('end', () => {
        debug('Connection to imap server ended');
        resolve(false);
      });

      mailServer.once('ready', async () => {
        debug('Connected to imap server');

        debug('Open inbox');
        const proceed = await _openInbox(mailServer);
        if (!proceed) {
          debug('Unable to open inbox');
          resolve(false);
          return;
        }

        try {
          await _requestMFACode.call(this);
        } catch (err) {
          debug(err);
          resolve(false);
          return;
        }

        let uids;
        let email;
        let sucess = false;
        try {
          // Find MFA email
          uids = await _searchForEmail(mailServer, 4);

          // Get MFA email as html
          email = await _fetchEmail(mailServer, uids);

          // Extract code from MFA email
          await _getMFACode(email);

          // Delete MFA email
          await _deleteEmail(mailServer, uids);

          sucess = true;
        } catch (err) {
          debug(err.message);
          sucess = false;
        } finally {
          // mailServer.end();
          resolve(sucess);
        }
      });

      mailServer.connect();
    } catch (err) {
      debug(err.message);
      resolve(false);
    }
  });
}

// Submit MFA token
async function _submitMFACode() {
  debug('Submit MFA code');
  try {
    const url = AUTH_URLS_MFA.SUBMIT_MFACODE;
    const postBody = {
      factorAuthCode: auth.factorAuthCode,
      isBrowserTrusted: true,
      otp: auth.MFACode,
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

    auth.token = response.data.token;
    const buff = Buffer.from(auth.token);
    const tokenBase64 = buff.toString('base64');
    this.headers.authorization = tokenBase64;
    auth.tokenExpires = response.data.expiresIn;

    return true;
  } catch (err) {
    debug('Error in response object');
    debug(err);
    return false;
  }
}

// Verifiy authorization token
async function _verifyAuthToken() {
  debug('Verifiy authorization token');
  try {
    const url = AUTH_URLS_MFA.VERIFY_AUTH + auth.authenticated;
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
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
    this.headers.accept = 'application/json';
    this.headers.authorization = auth.token;
    // this.headers.Host = API_DOMAIN;

    const url = AUTH_URLS_MFA.START_NEW_SESSION;
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

export default {
  _validateToken,
  _getAuthToken,
  _getFactors,
  _getMFACodeFromEmail,
  _submitMFACode,
  _requestMFACode,
  _verifyAuthToken,
  _newSession,
};
