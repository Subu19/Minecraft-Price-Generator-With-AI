const chalk = require('chalk').default || require('chalk');
const Ora = require('ora').default || require('ora');

class Logger {
  constructor() {
    this.spinner = null;
    this.logBuffer = [];
    this.logFile = null;
  }

  setLogFile(filePath) {
    this.logFile = filePath;
    const fs = require('fs');
    // Clear log file
    fs.writeFileSync(filePath, '', 'utf8');
  }

  _writeLog(message) {
    if (this.logFile) {
      const fs = require('fs');
      const timestamp = new Date().toISOString();
      fs.appendFileSync(this.logFile, `[${timestamp}] ${message}\n`, 'utf8');
    }
  }

  header(text) {
    const line = '═'.repeat(text.length + 4);
    console.log(`\n${chalk.cyan(line)}`);
    console.log(chalk.cyan.bold(`  ${text}`));
    console.log(`${chalk.cyan(line)}\n`);
    this._writeLog(`\n${'='.repeat(text.length + 4)}\n${text}\n${'='.repeat(text.length + 4)}\n`);
  }

  info(text) {
    console.log(chalk.blue('ℹ') + ' ' + text);
    this._writeLog(`[INFO] ${text}`);
  }

  success(text) {
    console.log(chalk.green('✓') + ' ' + chalk.green(text));
    this._writeLog(`[SUCCESS] ${text}`);
  }

  warn(text) {
    console.log(chalk.yellow('⚠') + ' ' + chalk.yellow(text));
    this._writeLog(`[WARN] ${text}`);
  }

  error(text) {
    console.log(chalk.red('✗') + ' ' + chalk.red(text));
    this._writeLog(`[ERROR] ${text}`);
  }

  startSpinner(text) {
    if (this.spinner) this.spinner.stop();
    this.spinner = new Ora(chalk.cyan(text)).start();
    this._writeLog(`[SPINNER] ${text}`);
  }

  updateSpinner(text) {
    if (this.spinner) {
      this.spinner.text = chalk.cyan(text);
    }
    this._writeLog(`[SPINNER] ${text}`);
  }

  stopSpinner(finalText, success = true) {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(chalk.green(finalText));
      } else {
        this.spinner.fail(chalk.red(finalText));
      }
      this.spinner = null;
    }
    this._writeLog(`[SPINNER] ${finalText}`);
  }

  chunk(chunkNum, total) {
    console.log(chalk.magenta(`\n📦 Processing chunk ${chunkNum}/${total}`));
    this._writeLog(`\nProcessing chunk ${chunkNum}/${total}`);
  }

  streaming(token) {
    process.stdout.write(chalk.gray(token));
  }

  streamingDone() {
    console.log(chalk.gray('\n'));
  }

  modelOutput(label, text) {
    console.log(chalk.yellow('\n🤖 ' + label + ':'));
    if (text) console.log(chalk.gray(text));
    this._writeLog(`\n[MODEL OUTPUT] ${label}:\n${text}\n`);
  }

  jsonParsed(json, itemCount) {
    console.log(chalk.green(`\n✓ Parsed JSON with ${itemCount} items`));
    this._writeLog(`[JSON] Parsed successfully - ${itemCount} items`);
  }

  stats(label, value) {
    console.log(chalk.blueBright(`  ${label}: ${value}`));
    this._writeLog(`[STATS] ${label}: ${value}`);
  }

  section(text) {
    console.log(chalk.magenta(`\n━━━ ${text} ━━━`));
    this._writeLog(`\n━━━ ${text} ━━━`);
  }
}

module.exports = new Logger();
