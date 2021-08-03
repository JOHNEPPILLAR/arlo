/**
 * Import libraries
 */
const Imap = require('imap');
const emailParser = require('mailparser').simpleParser;
const { parse } = require('node-html-parser');
const { setTimeout } = require('timers/promises');
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

    if (!response.mfa) {
      debug('Account is not 2FA enabled');
      return false;
    }

    const { token } = response;
    const buff = Buffer.from(token);
    const tokenBase64 = buff.toString('base64');
    this.headers.Authorization = tokenBase64;
    auth.authenticated = response.authenticated;
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

    auth.factorAuthCode = response.factorAuthCode;
    return true;
  } catch (err) {
    debug(err.message);
    return false;
  }
}

// Get 2fa code from email body
function _get2FACode(message) {
  try {
    debug('Parse html');
    const root = parse(message);

    debug('Find H1');
    const h1 = root.querySelector('h1');

    debug('Strip out non text chars');
    const mfaCode = h1.text.replace(/\r?\n|\r/g, '');

    debug('Got 2fa code');
    auth.mfaCode = mfaCode.trim();
    return true;
  } catch (err) {
    debug(err);
    return err;
  }
}

// Search for Email in inbox
function _searchForEmail(mailServer) {
  return new Promise((resolve, reject) => {
    const searchCriteria = [
      'UNSEEN',
      ['SUBJECT', 'Your one-time authentication code from Arlo'],
    ];

    debug('Get uids');
    try {
      mailServer.search(searchCriteria, (err, uids) => {
        if (err) {
          reject(err);
          return;
        }

        if (!uids || !uids.length) {
          resolve([]);
          return;
        }

        mailServer.setFlags(uids, ['\\Seen'], (err) => {
          if (err) debug(err);
          else debug('Marked message as read');
        });

        resolve(uids);
      });
    } catch (err) {
      debug(err);
    }
  });
}

// Tidy up mail box
function _tidyUpMailBox(mailServer) {
  return new Promise((resolve, reject) => {
    const searchCriteria = [
      ['SUBJECT', 'Your one-time authentication code from Arlo'],
    ];

    debug('Get uids');
    try {
      mailServer.search(searchCriteria, async (err, uids) => {
        if (err) {
          reject(err);
          return;
        }

        if (!uids || !uids.length) {
          resolve([]);
          return;
        }

        debug(`Found ${uids.length} 2fa email(s)`);
        uids.forEach(async (uid) => {
          await _deleteEmail(mailServer, [uid]);
        });

        resolve(true);
      });
    } catch (err) {
      debug(err);
    }
  });
}

// Fetch Email content
function _fetchEmail(mailServer, uid) {
  return new Promise((resolve, reject) => {
    const fetchOptions = {
      bodies: ['TEXT'],
      markSeen: true,
      struct: true,
    };
    const fetch = mailServer.fetch(uid, fetchOptions);

    function fetchOnMessage(message) {
      debug('Got a message from server');

      message.on('body', (stream, info) => {
        emailParser(stream, (err, mail) => {
          if (err) {
            debug(err);
            reject(err);
          }
          resolve(mail.html);
        });
      });

      message.once('end', function () {
        debug('Finished processing raw email');
      });
    }

    function fetchOnError(err) {
      fetch.removeListener('message', fetchOnMessage);
      fetch.removeListener('end', fetchOnEnd);
      reject(err);
    }

    function fetchOnEnd() {
      fetch.removeListener('message', fetchOnMessage);
      fetch.removeListener('error', fetchOnError);
    }

    fetch.on('message', fetchOnMessage);
    fetch.once('error', fetchOnError);
    fetch.once('end', fetchOnEnd);
  });
}

// Delete email
function _deleteEmail(mailServer, uid) {
  return new Promise((resolve, reject) => {
    debug('Delete arlo 2fa email');
    mailServer.addFlags(uid[0], 'Deleted', (err) => {
      if (err) {
        reject(err);
        return;
      }

      mailServer.expunge((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
}

function _get2faCodeFromEmail(emailServerConfig) {
  debug('Login to mail server');
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve) => {
    try {
      debug('Connect to mail server');
      const mailServer = new Imap(emailServerConfig);

      mailServer.once('error', (err) => {
        debug(err);
        resolve(false);
      });

      mailServer.once('end', () => {
        debug('Connection to imap server ended');
      });

      mailServer.once('ready', () => {
        debug('Connected to imap server');

        debug('Open inbox');
        mailServer.openBox('INBOX', false, async (err, box) => {
          try {
            if (err) throw new Error(err);

            debug('Clean up mailbox before requesting new 2fa code');
            await _tidyUpMailBox(mailServer);
            debug('Clean mailbox');

            // Request 2fa email
            const proceed = await _request2fa.call(this);
            if (!proceed) {
              resolve(false);
              return;
            }

            // Get uid's
            var uid;
            var retryCounter = 0;
            const timeout = 10000;
            while (retryCounter < 3) {
              await setTimeout(timeout); // Wait for email to be send by Arlo
              uid = await _searchForEmail(mailServer);
              if (uid instanceof Error || !uid || uid.length === 0) {
                debug('No emails found');
              }
              if (uid.length > 0) {
                debug('Found 2fa email');
                break;
              }
              retryCounter += 1;
            }

            if (!uid || uid.length === 0) {
              debug('No 2fa email received from Arlo');
              resolve(false);
              return;
            }

            // Fetch email content from uid
            const message = await _fetchEmail(mailServer, uid);
            if (message instanceof Error) {
              resolve(false);
              return;
            }

            // Extract mfa code
            const mfaCode = _get2FACode(message);
            if (mfaCode instanceof Error) {
              resolve(false);
              return;
            }

            // Delete email
            await _deleteEmail(mailServer, uid);

            debug('Close connection to mail server');
            await mailServer.closeBox(true, (err) => {
              if (err) debug(err);
            });

            await mailServer.end();

            resolve(true);
          } catch (err) {
            debug(err);
            resolve(false);
          }
        });
      });

      mailServer.connect();
    } catch (err) {
      debug(err.message);
      resolve(false);
    }
  });
}

// Submit 2fa token
async function _submit2faCode() {
  debug('Submit 2fa token');
  try {
    const url = AUTH_URLS.SUBMIT_MFACODE;
    const postBody = {
      factorAuthCode: auth.factorAuthCode,
      otp: auth.mfaCode,
    };

    const response = await this._post(url, postBody);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    auth.token = response.token;
    const buff = Buffer.from(auth.token);
    const tokenBase64 = buff.toString('base64');
    this.headers.Authorization = tokenBase64;
    auth.tokenExpires = response.expiresIn;
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
    const url = AUTH_URLS.VERIFY_AUTH + auth.authenticated;
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
    this.headers.authorization = this.token;

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
