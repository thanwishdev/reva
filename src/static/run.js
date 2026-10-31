#!/usr/bin/env node
import { main } from './index.js';
main().then(code => process.exit(code), err => { console.error(err.message); process.exit(1); });
