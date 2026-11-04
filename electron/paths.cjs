// Where Spread keeps its files. `npm run dev` gets its own folder, so a dev copy can run beside the
// installed app without sharing its projects, library or bridge. SPREAD_HOME overrides both, and
// child processes (the MCP server behind the Claude panel) inherit it.
const os = require('os');
const path = require('path');

const DEV = !!process.env.SPREAD_DEV_URL;
const SPREAD_DIR = process.env.SPREAD_HOME || path.join(os.homedir(), DEV ? '.spread-dev' : '.spread');
process.env.SPREAD_HOME = SPREAD_DIR;

module.exports = { DEV, SPREAD_DIR };
