/**
 * Import libraries
 */
import DebugModule from 'debug';
// eslint-disable-next-line import/no-unresolved
import { setTimeout } from 'timers/promises';

const debug = new DebugModule('Arlo:mfa');
const URL_MFA_BASE = 'https://ocapi-app.arlo.com/api/v2';
const AUTH_URLS = {
  VALID_TOKEN: `${URL_MFA_BASE}/ocAccessTokenValidate_PHP_MFA`,
  GET_AUTH_TOKEN: `${URL_MFA_BASE}/ocAuth_PHP_MFA`,
  GET_FACTORS: `${URL_MFA_BASE}/ocGetFactors_PHP_MFA`,
  START_2FA_AUTH: `${URL_MFA_BASE}/ocStart2FAauth_PHP_MFA`,
  VALIDATE_ACCESS_TOKEN: `${URL_MFA_BASE}/ocAccessTokenValidate_PHP_MFA`,
};

const auth = {};

// Validate authorization token
async function _validateToken() {
  try {
    const url = AUTH_URLS.VALID_TOKEN;
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      return false;
    }

    if (response.meta.code != 200) {
      debug(response.meta.message);
      return false
    }
  } catch (err) {
    debug(err.message);
    return err;
  }
}

// Get authorization token
async function _getAuthToken(email, password) {
  try {
    debug('Get auth token');
    const url = AUTH_URLS.GET_AUTH_TOKEN;
    const postBody = {
      email,
      password,
    };

    const response = await this._post(url, postBody);
    if (response instanceof Error || typeof response === 'undefined') {
      return false;
    }

    if (response.meta.code != 200) {
      debug(response.meta.message);
      return false
    }

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

    const url = AUTH_URLS.GET_FACTORS
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code != 200) {
      debug(response.meta.message);
      return false
    }

    debug('Filter factors to get push');
    const factor = response.data.items.filter(
      (item) => item.factorType === 'PUSH',
    );

    if (factor.length < 1) {
      debug('No 2fa found');
      return false
    }

    auth.factorID = factor[0].factorId;
    auth.applicationID = factor[0].applicationId;

    return true;
  } catch (err) {
    debug(err.message);
    return err;
  }  
}

// Start 2fa auth
async function _start2faAuth() {
  try {
    debug('Start 2fa auth');
    const url = AUTH_URLS.START_2FA_AUTH + `?applicationId=${auth.applicationID}`;
    const postBody = {
      factorId: auth.factorID,
      mobilePayload: this.mobilePayload,
    };
    const response = await this._post(url, postBody);

    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code != 200) {
      debug(response.meta.message);
      return false
    }

    this.token = response.data.accessToken.token;
    this.tokenExpires = response.data.accessToken.expiredIn
    this.headers.accessToken = this.token;

    return true;
  } catch (err) {
    debug(err.message);
    return err;
  }  
}

// Validate access token
async function _validateAccessToken() {
  debug('Validate 2fa token');
  try {
    const url = AUTH_URLS.VALIDATE_ACCESS_TOKEN;
    const response = await this._get(url);
    if (response instanceof Error || typeof response === 'undefined') {
      debug(response);
      return false;
    }

    if (response.meta.code != 200) {
      debug(response.meta.message);
      return false
    }

    if (!response.data.tokenValidated) {
      debug('Token not validated');
      return false
    }

    return true;
  } catch (err) {
    debug('Error in response object');
    debug(err);
    return false;
  }
}

export default {
  _validateToken,
  _getAuthToken,
  _getFactors,
  _start2faAuth,
  _validateAccessToken,
};
