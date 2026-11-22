'use strict';
const config = require('./config');
const { createApp } = require('./app');

createApp().listen(config.port, () => {
  console.log(`Pharmacie Manager Pro — http://localhost:${config.port}`);
});
