const serverless = require('serverless-http');
const app = require('../server');

module.exports = (req, res) => serverless(app)(req, res);
