'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const events = require('events');
const common = require('@metarhia/common');
const { WritableFileStream } = require('metastreams');
const concolor = require('concolor');

const DAY_MILLISECONDS = common.duration('1d');
const DEFAULT_WRITE_INTERVAL = common.duration('3s');
const DEFAULT_BUFFER_SIZE = 64 * 1024;
const DEFAULT_KEEP_DAYS = 1;
const STACK_AT = '  at ';
const TYPE_LENGTH = 6;
const LINE_SEPARATOR = ';';

const LOG_TYPES = ['error', 'warn', 'info', 'debug', 'log'];

const typeColor = concolor({
  log: 'b,black/white',
  info: 'b,white/blue',
  warn: 'b,black/yellow',
  debug: 'b,white/green',
  error: 'b,yellow/red',
});

const textColor = concolor({
  log: 'white',
  info: 'white',
  warn: 'b,yellow',
  debug: 'b,green',
  error: 'red',
});

// Convert array to boolean flags
//   types <string[]>
// Returns: <Object>
const logTypes = types => {
  types = types || LOG_TYPES;
  const flags = {};
  for (const type of types) {
    flags[type] = true;
  }
  return flags;
};

const replace = (str, substr, newstr) => {
  if (substr === '') return str;
  let src = str;
  let res = '';
  do {
    const index = src.indexOf(substr);
    if (index === -1) return res + src;
    const start = src.substring(0, index);
    src = src.substring(index + substr.length, src.length);
    res += start + newstr;
  } while (true);
};

const nowDays = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  const date = new Date(year, month, day, 0, 0, 0, 0);
  return Math.floor(date.getTime() / DAY_MILLISECONDS);
};

const nameToDays = fileName => {
  const fileTime = new Date(fileName.substring(0, 10)).getTime();
  return Math.floor(fileTime / DAY_MILLISECONDS);
};

class Logger extends events.EventEmitter {
  // path <string> log directory
  // workerId <string> workwr process or thread id
  // writeInterval <number> flush log to disk interval
  // writeBuffer <number> buffer size (default 64kb)
  // keepDays <number> delete files after N days, 0 to disable
  // toFile <string[]> write log types to file
  // toStdout <string[]> write log types to stdout
  // Writable <class> writable stream class
  // home <string> remove home paths from stack traces
  constructor(args) {
    super();
    const { workerId = 0, Writable = WritableFileStream } = args;
    const { writeInterval, writeBuffer, keepDays, home } = args;
    const { toFile, toStdout } = args;
    this.active = false;
    this.path = args.path;
    this.workerId = `W${workerId}`;
    this.Writable = Writable;
    this.writeInterval = writeInterval || DEFAULT_WRITE_INTERVAL;
    this.writeBuffer = writeBuffer || DEFAULT_BUFFER_SIZE;
    this.keepDays = keepDays || DEFAULT_KEEP_DAYS;
    this.home = home;
    this.stream = null;
    this.reopenTimer = null;
    this.flushTimer = null;
    this.lock = false;
    this.buffer = [];
    this.file = '';
    this.toFile = logTypes(toFile);
    this.fsEnabled = Object.keys(this.toFile).length !== 0;
    this.toStdout = logTypes(toStdout);
    return this.open();
  }

  async open() {
    if (this.active) return this;
    this.active = true;
    if (!this.fsEnabled) {
      process.nextTick(() => this.emit('open'));
      return this;
    }
    const fileName = common.nowDate() + '-' + this.workerId + '.log';
    this.file = path.join(this.path, fileName);
    const now = new Date();
    const nextDate = new Date();
    nextDate.setUTCHours(0, 0, 0, 0);
    const nextReopen = nextDate - now + DAY_MILLISECONDS;
    this.reopenTimer = setTimeout(() => {
      this.once('close', () => {
        this.open();
      });
      this.close();
    }, nextReopen);
    if (this.keepDays) await this.rotate();
    const options = { flags: 'a', bufferSize: this.writeBuffer };
    this.stream = new this.Writable(this.file, options);
    this.flushTimer = setInterval(() => {
      this.flush();
    }, this.writeInterval);
    this.stream.on('open', () => {
      this.emit('open');
    });
    this.stream.on('error', () => {
      this.emit('error', new Error(`Can't open log file: ${this.file}`));
    });
    await events.once(this, 'open');
    return this;
  }

  async close() {
    if (!this.active) return Promise.resolve();
    if (!this.fsEnabled) {
      this.active = false;
      this.emit('close');
      return Promise.resolve();
    }
    const { stream } = this;
    if (!stream || stream.destroyed || stream.closed) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.flush(err => {
        if (err) {
          process.stdout.write(`${err.stack}\n`);
          this.emit('error', err);
          reject(err);
          return;
        }
        this.active = false;
        stream.end(() => {
          clearInterval(this.flushTimer);
          clearTimeout(this.reopenTimer);
          this.flushTimer = null;
          this.reopenTimer = null;
          const fileName = this.file;
          this.emit('close');
          resolve();
          fs.stat(fileName, (err, stats) => {
            if (!err && stats.size === 0) {
              fsp.unlink(this.file);
            }
          });
        });
      });
    });
  }

  async rotate() {
    if (!this.keepDays) return;
    const now = nowDays();
    const finish = [];
    try {
      const files = await fsp.readdir(this.path);
      for (const fileName of files) {
        if (common.fileExt(fileName) !== 'log') continue;
        const fileAge = now - nameToDays(fileName);
        if (fileAge < this.keepDays) continue;
        finish.push(fsp.unlink(path.join(this.path, fileName)));
      }
      await Promise.all(finish);
    } catch (err) {
      process.stdout.write(`${err.stack}\n`);
      this.emit('error', err);
    }
  }

  write(type, message) {
    const date = new Date();
    const dateTime = date.toISOString();
    if (this.toStdout[type]) {
      const normalColor = textColor[type];
      const markColor = typeColor[type];
      const time = normalColor(dateTime.substring(11, 19));
      const id = normalColor(this.workerId);
      const mark = markColor(' ' + type.padEnd(TYPE_LENGTH));
      const msg = normalColor(message);
      const line = `${time}  ${id}  ${mark}  ${msg}\n`;
      process.stdout.write(line);
    }
    if (this.toFile[type]) {
      const msg = replace(message, '\n', LINE_SEPARATOR);
      const line = `${dateTime} [${type}] ${msg}\n`;
      const buffer = Buffer.from(line);
      this.buffer.push(buffer);
    }
  }

  flush(callback) {
    if (this.lock) {
      if (callback) this.once('unlocked', callback);
      return;
    }
    if (this.buffer.length === 0) {
      if (callback) callback();
      return;
    }
    if (!this.active) {
      const err = new Error('Cannot flush log buffer: logger is not opened');
      this.emit('error', err);
      if (callback) callback(err);
      return;
    }
    this.lock = true;
    const buffer = Buffer.concat(this.buffer);
    this.buffer.length = 0;
    this.stream.write(buffer, () => {
      this.lock = false;
      this.emit('unlocked');
      if (callback) callback();
    });
  }

  normalizeStack(stack) {
    if (!stack) return 'no data to log';
    const index = stack.indexOf(STACK_AT);
    if (index === -1) return stack;
    let res = replace(stack, STACK_AT, '');
    if (this.home) res = replace(res, this.home, '');
    return res;
  }

  log(message) {
    this.write('log', message);
  }

  info(message) {
    this.write('info', message);
  }

  warn(message) {
    this.write('warn', message);
  }

  debug(message) {
    const msg = this.normalizeStack(message);
    this.write('debug', msg);
  }

  error(message) {
    const msg = this.normalizeStack(message);
    this.write('error', msg);
  }
}

const openLog = async args => new Logger(args);

module.exports = { Logger, openLog };
