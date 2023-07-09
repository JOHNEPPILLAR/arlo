![](arlo-logo.png)

![NodeJS](https://badges.aleen42.com/src/node.svg) ![Build](https://github.com/johneppillar/arlo/workflows/BUILD/badge.svg)

__IMPORTANT__ This library is now deprecated. Arlo changed their api's and I am taking the opportunity to port this to goLang.  

A nodeJS library for connecting to the [ARLO](https://arlo.com) camera system.

Based on the awesome work done by: [EpicKris (node-arlo)](https://github.com/EpicKris/node-arlo), [jeffreydwalter (python arlo)](https://github.com/jeffreydwalter/arlo) & [m0urs (python arlo-cli)](https://github.com/m0urs/arlo-cl).

---

## Why I created this library

This is a personal library that I created because I wanted to use my Arlo devices without the mobile app. It is by no means complete, although it does expose alot of the Arlo interface (reversed engineered). As such, this library does not come with unit tests (feel free to add them) or any kind of guarantees. Sometimes Arlo update their API's and this causes issues. 

Contributions are welcome and appreciated!🙏

__IMPORTANT__ If using the MFA via email option this library relies on using imap to retrieve the MFA code. If using google, please enable imap in the settings.

---

## Install

```sh
npm install node-arlo-cameras
```

## Usage

```javascript
import arlo from 'node-arlo-cameras';

const arloUser = '****@****.****';     // Arlo user
const arloPassword = '****';           // Arlo password
const emailUser = '****@gmail.com';    // Your email address registered to receive MFA
const emailPassword = '****';          // Your email password
const emailServer = 'imap.gmail.com';  // Email server
const updatePropertiesEvery = 5;       // Update device information every x minutes

const config = {
  arloUser,
  arloPassword,
  mfa: true, // Set to true to get mfa via email, false to use mobile app token
  emailUser,
  emailPassword,
  emailServer,
  updatePropertiesEvery,
};

async function logInToArlo() {
  const arlo = new Arlo(config);
  if (arlo instanceof Error) {
    console.error(arlo.message);
    return false;
  }

  console.log(`Login to Arlo`);
  const sucess = await arlo.login();
  if (!sucess) {
    console.error('Not able to login to Arlo');
    return false;
  }
  console.log('Logged into Arlo');
  return true;
}

logInToArlo();

```

## Check out the [examples](https://github.com/JOHNEPPILLAR/arlo/tree/main/examples) folder for more.
