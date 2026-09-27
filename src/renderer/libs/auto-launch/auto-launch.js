'use strict';

var require$$0$1 = require('fs');
var require$$1 = require('path');
var require$$0 = require('util');
var require$$2 = require('child_process');
var require$$0$2 = require('os');

function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}

var pathIsAbsolute = {exports: {}};

var hasRequiredPathIsAbsolute;

function requirePathIsAbsolute () {
	if (hasRequiredPathIsAbsolute) return pathIsAbsolute.exports;
	hasRequiredPathIsAbsolute = 1;

	function posix(path) {
		return path.charAt(0) === '/';
	}

	function win32(path) {
		// https://github.com/nodejs/node/blob/b3fcc245fb25539909ef1d5eaa01dbf92e168633/lib/path.js#L56
		var splitDeviceRe = /^([a-zA-Z]:|[\\\/]{2}[^\\\/]+[\\\/]+[^\\\/]+)?([\\\/])?([\s\S]*?)$/;
		var result = splitDeviceRe.exec(path);
		var device = result[1] || '';
		var isUnc = Boolean(device && device.charAt(1) !== ':');

		// UNC paths are always absolute
		return Boolean(result[2] || isUnc);
	}

	pathIsAbsolute.exports = process.platform === 'win32' ? win32 : posix;
	pathIsAbsolute.exports.posix = posix;
	pathIsAbsolute.exports.win32 = win32;
	return pathIsAbsolute.exports;
}

/************************************************************************************************************
 * registry.js - contains a wrapper for the REG command under Windows, which provides access to the registry
 *
 * @author Paul Bottin a/k/a FrEsC
 *
 */

var registry;
var hasRequiredRegistry;

function requireRegistry () {
	if (hasRequiredRegistry) return registry;
	hasRequiredRegistry = 1;
	/* imports */
	var util          = require$$0
	,   path          = require$$1
	,   spawn         = require$$2.spawn

	/* set to console.log for debugging */
	,   HKLM          = 'HKLM'
	,   HKCU          = 'HKCU'
	,   HKCR          = 'HKCR'
	,   HKU           = 'HKU'
	,   HKCC          = 'HKCC'
	,   HIVES         = [ HKLM, HKCU, HKCR, HKU, HKCC ]

	/* registry value type ids */
	,   REG_SZ        = 'REG_SZ'
	,   REG_MULTI_SZ  = 'REG_MULTI_SZ'
	,   REG_EXPAND_SZ = 'REG_EXPAND_SZ'
	,   REG_DWORD     = 'REG_DWORD'
	,   REG_QWORD     = 'REG_QWORD'
	,   REG_BINARY    = 'REG_BINARY'
	,   REG_NONE      = 'REG_NONE'
	,   REG_TYPES     = [ REG_SZ, REG_MULTI_SZ, REG_EXPAND_SZ, REG_DWORD, REG_QWORD, REG_BINARY, REG_NONE ]

	/* default registry value name */
	,   DEFAULT_VALUE = ''

	/* general key pattern */
	,   KEY_PATTERN   = /(\\[a-zA-Z0-9_\s]+)*/

	/* key path pattern (as returned by REG-cli) */
	,   PATH_PATTERN  = /^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG)(.*)$/

	/* registry item pattern */
	,   ITEM_PATTERN  = /^(.*)\s(REG_SZ|REG_MULTI_SZ|REG_EXPAND_SZ|REG_DWORD|REG_QWORD|REG_BINARY|REG_NONE)\s+([^\s].*)$/;

	/**
	 * Creates an Error object that contains the exit code of the REG.EXE process.
	 * This contructor is private. Objects of this type are created internally and returned in the <code>err</code> parameters in case the REG.EXE process doesn't exit cleanly.
	 *
	 * @private
	 * @class
	 *
	 * @param {string} message - the error message
	 * @param {number} code - the process exit code
	 *
	 */
	function ProcessUncleanExitError(message, code) {
	  if (!(this instanceof ProcessUncleanExitError))
	    return new ProcessUncleanExitError(message, code);

	  Error.captureStackTrace(this, ProcessUncleanExitError);

	  /**
	   * The error name.
	   * @readonly
	   * @member {string} ProcessUncleanExitError#name
	   */
	  this.__defineGetter__('name', function () { return ProcessUncleanExitError.name; });

	  /**
	   * The error message.
	   * @readonly
	   * @member {string} ProcessUncleanExitError#message
	   */
	  this.__defineGetter__('message', function () { return message; });

	  /**
	   * The process exit code.
	   * @readonly
	   * @member {number} ProcessUncleanExitError#code
	   */
	  this.__defineGetter__('code', function () { return code; });

	}

	util.inherits(ProcessUncleanExitError, Error);

	/*
	 * Captures stdout/stderr for a child process
	 */
	function captureOutput(child) {
	  // Use a mutable data structure so we can append as we get new data and have
	  // the calling context see the new data
	  var output = {'stdout': '', 'stderr': ''};

	  child.stdout.on('data', function(data) { output["stdout"] += data.toString(); });
	  child.stderr.on('data', function(data) { output["stderr"] += data.toString(); });

	  return output;
	}


	/*
	 * Returns an error message containing the stdout/stderr of the child process
	 */
	function mkErrorMsg(registryCommand, code, output) {
	    var stdout = output['stdout'].trim();
	    var stderr = output['stderr'].trim();

	    var msg = util.format("%s command exited with code %d:\n%s\n%s", registryCommand, code, stdout, stderr);
	    return new ProcessUncleanExitError(msg, code);
	}


	/*
	 * Converts x86/x64 to 32/64
	 */
	function convertArchString(archString) {
	  if (archString == 'x64') {
	    return '64';
	  } else if (archString == 'x86') {
	    return '32';
	  } else {
	    throw new Error('illegal architecture: ' + archString + ' (use x86 or x64)');
	  }
	}


	/*
	 * Adds correct architecture to reg args
	 */
	function pushArch(args, arch) {
	  if (arch) {
	    args.push('/reg:' + convertArchString(arch));
	  }
	}

	/*
	 * Get the path to system's reg.exe. Useful when another reg.exe is added to the PATH
	 * Implemented only for Windows
	 */
	function getRegExePath() {
	    if (process.platform === 'win32') {
	        return path.join(process.env.windir, 'system32', 'reg.exe');
	    } else {
	        return "REG";
	    }
	}


	/**
	 * Creates a single registry value record.
	 * This contructor is private. Objects of this type are created internally and returned by methods of {@link Registry} objects.
	 *
	 * @private
	 * @class
	 *
	 * @param {string} host - the hostname
	 * @param {string} hive - the hive id
	 * @param {string} key - the registry key
	 * @param {string} name - the value name
	 * @param {string} type - the value type
	 * @param {string} value - the value
	 * @param {string} arch - the hive architecture ('x86' or 'x64')
	 *
	 */
	function RegistryItem (host, hive, key, name, type, value, arch) {

	  if (!(this instanceof RegistryItem))
	    return new RegistryItem(host, hive, key, name, type, value, arch);

	  /* private members */
	  var _host = host    // hostname
	  ,   _hive = hive    // registry hive
	  ,   _key = key      // registry key
	  ,   _name = name    // property name
	  ,   _type = type    // property type
	  ,   _value = value  // property value
	  ,   _arch = arch;    // hive architecture

	  /* getters/setters */

	  /**
	   * The hostname.
	   * @readonly
	   * @member {string} RegistryItem#host
	   */
	  this.__defineGetter__('host', function () { return _host; });

	  /**
	   * The hive id.
	   * @readonly
	   * @member {string} RegistryItem#hive
	   */
	  this.__defineGetter__('hive', function () { return _hive; });

	  /**
	   * The registry key.
	   * @readonly
	   * @member {string} RegistryItem#key
	   */
	  this.__defineGetter__('key', function () { return _key; });

	  /**
	   * The value name.
	   * @readonly
	   * @member {string} RegistryItem#name
	   */
	  this.__defineGetter__('name', function () { return _name; });

	  /**
	   * The value type.
	   * @readonly
	   * @member {string} RegistryItem#type
	   */
	  this.__defineGetter__('type', function () { return _type; });

	  /**
	   * The value.
	   * @readonly
	   * @member {string} RegistryItem#value
	   */
	  this.__defineGetter__('value', function () { return _value; });

	  /**
	   * The hive architecture.
	   * @readonly
	   * @member {string} RegistryItem#arch
	   */
	  this.__defineGetter__('arch', function () { return _arch; });

	}

	util.inherits(RegistryItem, Object);

	/**
	 * Creates a registry object, which provides access to a single registry key.
	 * Note: This class is returned by a call to ```require('winreg')```.
	 *
	 * @public
	 * @class
	 *
	 * @param {object} options - the options
	 * @param {string=} options.host - the hostname
	 * @param {string=} options.hive - the hive id
	 * @param {string=} options.key - the registry key
	 * @param {string=} options.arch - the optional registry hive architecture ('x86' or 'x64'; only valid on Windows 64 Bit Operating Systems)
	 *
	 * @example
	 * var Registry = require('winreg')
	 * ,   autoStartCurrentUser = new Registry({
	 *       hive: Registry.HKCU,
	 *       key:  '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
	 *     });
	 *
	 */
	function Registry (options) {

	  if (!(this instanceof Registry))
	    return new Registry(options);

	  /* private members */
	  var _options = options || {}
	  ,   _host = '' + (_options.host || '')    // hostname
	  ,   _hive = '' + (_options.hive || HKLM)  // registry hive
	  ,   _key  = '' + (_options.key  || '')    // registry key
	  ,   _arch = _options.arch || null;         // hive architecture

	  /* getters/setters */

	  /**
	   * The hostname.
	   * @readonly
	   * @member {string} Registry#host
	   */
	  this.__defineGetter__('host', function () { return _host; });

	  /**
	   * The hive id.
	   * @readonly
	   * @member {string} Registry#hive
	   */
	  this.__defineGetter__('hive', function () { return _hive; });

	  /**
	   * The registry key name.
	   * @readonly
	   * @member {string} Registry#key
	   */
	  this.__defineGetter__('key', function () { return _key; });

	  /**
	   * The full path to the registry key.
	   * @readonly
	   * @member {string} Registry#path
	   */
	  this.__defineGetter__('path', function () { return (_host.length == 0 ? '' : '\\\\' + _host + '\\') + _hive + _key; });

	  /**
	   * The registry hive architecture ('x86' or 'x64').
	   * @readonly
	   * @member {string} Registry#arch
	   */
	  this.__defineGetter__('arch', function () { return _arch; });

	  /**
	   * Creates a new {@link Registry} instance that points to the parent registry key.
	   * @readonly
	   * @member {Registry} Registry#parent
	   */
	  this.__defineGetter__('parent', function () {
	    var i = _key.lastIndexOf('\\');
	    return new Registry({
	      host: this.host,
	      hive: this.hive,
	      key:  (i == -1)?'':_key.substring(0, i),
	      arch: this.arch
	    });
	  });

	  // validate options...
	  if (HIVES.indexOf(_hive) == -1)
	    throw new Error('illegal hive specified.');

	  if (!KEY_PATTERN.test(_key))
	    throw new Error('illegal key specified.');

	  if (_arch && _arch != 'x64' && _arch != 'x86')
	    throw new Error('illegal architecture specified (use x86 or x64)');

	}

	/**
	 * Registry hive key HKEY_LOCAL_MACHINE.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKLM = HKLM;

	/**
	 * Registry hive key HKEY_CURRENT_USER.
	 * @type {string}
	 */
	Registry.HKCU = HKCU;

	/**
	 * Registry hive key HKEY_CLASSES_ROOT.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKCR = HKCR;

	/**
	 * Registry hive key HKEY_USERS.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKU = HKU;

	/**
	 * Registry hive key HKEY_CURRENT_CONFIG.
	 * Note: For writing to this hive your program has to run with admin privileges.
	 * @type {string}
	 */
	Registry.HKCC = HKCC;

	/**
	 * Collection of available registry hive keys.
	 * @type {array}
	 */
	Registry.HIVES = HIVES;

	/**
	 * Registry value type STRING.
	 * @type {string}
	 */
	Registry.REG_SZ = REG_SZ;

	/**
	 * Registry value type MULTILINE_STRING.
	 * @type {string}
	 */
	Registry.REG_MULTI_SZ = REG_MULTI_SZ;

	/**
	 * Registry value type EXPANDABLE_STRING.
	 * @type {string}
	 */
	Registry.REG_EXPAND_SZ = REG_EXPAND_SZ;

	/**
	 * Registry value type DOUBLE_WORD.
	 * @type {string}
	 */
	Registry.REG_DWORD = REG_DWORD;

	/**
	 * Registry value type QUAD_WORD.
	 * @type {string}
	 */
	Registry.REG_QWORD = REG_QWORD;

	/**
	 * Registry value type BINARY.
	 * @type {string}
	 */
	Registry.REG_BINARY = REG_BINARY;

	/**
	 * Registry value type UNKNOWN.
	 * @type {string}
	 */
	Registry.REG_NONE = REG_NONE;

	/**
	 * Collection of available registry value types.
	 * @type {array}
	 */
	Registry.REG_TYPES = REG_TYPES;

	/**
	 * The name of the default value. May be used instead of the empty string literal for better readability.
	 * @type {string}
	 */
	Registry.DEFAULT_VALUE = DEFAULT_VALUE;

	/**
	 * Retrieve all values from this registry key.
	 * @param {valuesCallback} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {array=} cb.items - an array of {@link RegistryItem} objects
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.values = function values (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = [ 'QUERY', this.path ];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    } else {
	      var items = []
	      ,   result = []
	      ,   lines = buffer.split('\n')
	      ,   lineNumber = 0;

	      for (var i = 0, l = lines.length; i < l; i++) {
	        var line = lines[i].trim();
	        if (line.length > 0) {
	          if (lineNumber != 0) {
	            items.push(line);
	          }
	          ++lineNumber;
	        }
	      }

	      for (var i = 0, l = items.length; i < l; i++) {

	        var match = ITEM_PATTERN.exec(items[i])
	        ,   name
	        ,   type
	        ,   value;

	        if (match) {
	          name = match[1].trim();
	          type = match[2].trim();
	          value = match[3];
	          result.push(new RegistryItem(self.host, self.hive, self.key, name, type, value, self.arch));
	        }
	      }

	      cb(null, result);

	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Retrieve all subkeys from this registry key.
	 * @param {function (err, items)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {array=} cb.items - an array of {@link Registry} objects
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.keys = function keys (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = [ 'QUERY', this.path ];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.stdout.on('end', function () {

	    var items = []
	    ,   result = []
	    ,   lines = buffer.split('\n');

	    for (var i = 0, l = lines.length; i < l; i++) {
	      var line = lines[i].trim();
	      if (line.length > 0) {
	        items.push(line);
	      }
	    }

	    for (var i = 0, l = items.length; i < l; i++) {

	      var match = PATH_PATTERN.exec(items[i])
	      ,   key;

	      if (match) {
	        match[1];
	        key  = match[2];
	        if (key && (key !== self.key)) {
	          result.push(new Registry({
	            host: self.host,
	            hive: self.hive,
	            key:  key,
	            arch: self.arch
	          }));
	        }
	      }
	    }

	    cb(null, result);

	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Gets a named value from this registry key.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err, item)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {RegistryItem=} cb.item - the retrieved registry item
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.get = function get (name, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['QUERY', this.path];
	  if (name == '')
	    args.push('/ve');
	  else
	    args = args.concat(['/v', name]);

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   buffer = ''
	  ,   self = this
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('QUERY', code, output), null);
	    } else {
	      var items = []
	      ,   result = null
	      ,   lines = buffer.split('\n')
	      ,   lineNumber = 0;

	      for (var i = 0, l = lines.length; i < l; i++) {
	        var line = lines[i].trim();
	        if (line.length > 0) {
	          if (lineNumber != 0) {
	             items.push(line);
	          }
	          ++lineNumber;
	        }
	      }

	      //Get last item - so it works in XP where REG QUERY returns with a header
	      var item = items[items.length-1] || ''
	      ,   match = ITEM_PATTERN.exec(item)
	      ,   name
	      ,   type
	      ,   value;

	      if (match) {
	        name = match[1].trim();
	        type = match[2].trim();
	        value = match[3];
	        result = new RegistryItem(self.host, self.hive, self.key, name, type, value, self.arch);
	      }

	      cb(null, result);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	    buffer += data.toString();
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Sets a named value in this registry key, overwriting an already existing value.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {string} type - the value type
	 * @param {string} value - the value
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.set = function set (name, type, value, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  if (REG_TYPES.indexOf(type) == -1)
	    throw Error('illegal type specified.');

	  var args = ['ADD', this.path];
	  if (name == '')
	    args.push('/ve');
	  else
	    args = args.concat(['/v', name]);

	  args = args.concat(['/t', type, '/d', value, '/f']);

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('ADD', code, output));
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Remove a named value from this registry key. If name is empty, sets the default value of this key.
	 * Note: This key must be already existing.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.remove = function remove (name, cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = name ? ['DELETE', this.path, '/f', '/v', name] : ['DELETE', this.path, '/f', '/ve'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('DELETE', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Remove all subkeys and values (including the default value) from this registry key.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.clear = function clear (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['DELETE', this.path, '/f', '/va'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if(error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg("DELETE", code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Alias for the clear method to keep it backward compatible.
	 * @method
	 * @deprecated Use {@link Registry#clear} or {@link Registry#destroy} in favour of this method.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.erase = Registry.prototype.clear;

	/**
	 * Delete this key and all subkeys from the registry.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.destroy = function destroy (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['DELETE', this.path, '/f'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('DELETE', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Create this registry key. Note that this is a no-op if the key already exists.
	 * @param {function (err)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.create = function create (cb) {

	  if (typeof cb !== 'function')
	    throw new TypeError('must specify a callback');

	  var args = ['ADD', this.path, '/f'];

	  pushArch(args, this.arch);

	  var proc = spawn(getRegExePath(), args, {
	        cwd: undefined,
	        env: process.env,
	        stdio: [ 'ignore', 'pipe', 'pipe' ]
	      })
	  ,   error = null; // null means no error previously reported.

	  var output = captureOutput(proc);

	  proc.on('close', function (code) {
	    if (error) {
	      return;
	    } else if (code !== 0) {
	      cb(mkErrorMsg('ADD', code, output), null);
	    } else {
	      cb(null);
	    }
	  });

	  proc.stdout.on('data', function (data) {
	  });

	  proc.on('error', function(err) {
	    error = err;
	    cb(err);
	  });

	  return this;
	};

	/**
	 * Checks if this key already exists.
	 * @param {function (err, exists)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {boolean=} cb.exists - true if a registry key with this name already exists
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.keyExists = function keyExists (cb) {

	  this.values(function (err, items) {
	    if (err) {
	      // process should return with code 1 if key not found
	      if (err.code == 1) {
	        return cb(null, false);
	      }
	      // other error
	      return cb(err);
	    }
	    cb(null, true);
	  });

	  return this;
	};

	/**
	 * Checks if a value with the given name already exists within this key.
	 * @param {string} name - the value name, use {@link Registry.DEFAULT_VALUE} or an empty string for the default value
	 * @param {function (err, exists)} cb - callback function
	 * @param {ProcessUncleanExitError=} cb.err - error object or null if successful
	 * @param {boolean=} cb.exists - true if a value with the given name was found in this key
	 * @returns {Registry} this registry key object
	 */
	Registry.prototype.valueExists = function valueExists (name, cb) {

	  this.get(name, function (err, item) {
	    if (err) {
	      // process should return with code 1 if value not found
	      if (err.code == 1) {
	        return cb(null, false);
	      }
	      // other error
	      return cb(err);
	    }
	    cb(null, true);
	  });

	  return this;
	};

	registry = Registry;
	return registry;
}

var AutoLaunchWindows;
var hasRequiredAutoLaunchWindows;

function requireAutoLaunchWindows () {
	if (hasRequiredAutoLaunchWindows) return AutoLaunchWindows;
	hasRequiredAutoLaunchWindows = 1;
	var Winreg, fs, path, regKey;

	fs = require$$0$1;

	path = require$$1;

	Winreg = requireRegistry();

	regKey = new Winreg({
	  hive: Winreg.HKCU,
	  key: '\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
	});

	AutoLaunchWindows = {

	  /* Public */
	  enable: function(arg) {
	    var appName, appPath, isHiddenOnLaunch;
	    appName = arg.appName, appPath = arg.appPath, isHiddenOnLaunch = arg.isHiddenOnLaunch;
	    return new Promise(function(resolve, reject) {
	      var args, pathToAutoLaunchedApp, ref, updateDotExe;
	      pathToAutoLaunchedApp = appPath;
	      args = '';
	      updateDotExe = path.join(path.dirname(process.execPath), '..', 'update.exe');
	      if ((((ref = process.versions) != null ? ref.electron : void 0) != null) && fs.existsSync(updateDotExe)) {
	        pathToAutoLaunchedApp = updateDotExe;
	        args = " --processStart \"" + (path.basename(process.execPath)) + "\"";
	        if (isHiddenOnLaunch) {
	          args += ' --process-start-args "--hidden"';
	        }
	      } else {
	        if (isHiddenOnLaunch) {
	          args += ' --hidden';
	        }
	      }
	      return regKey.set(appName, Winreg.REG_SZ, "\"" + pathToAutoLaunchedApp + "\"" + args, function(err) {
	        if (err != null) {
	          return reject(err);
	        }
	        return resolve();
	      });
	    });
	  },
	  disable: function(appName) {
	    return new Promise(function(resolve, reject) {
	      return regKey.remove(appName, function(err) {
	        if (err != null) {
	          if (err.message.indexOf('The system was unable to find the specified registry key or value') !== -1) {
	            return resolve(false);
	          }
	          return reject(err);
	        }
	        return resolve();
	      });
	    });
	  },
	  isEnabled: function(appName) {
	    return new Promise(function(resolve, reject) {
	      return regKey.get(appName, function(err, item) {
	        if (err != null) {
	          return resolve(false);
	        }
	        return resolve(item != null);
	      });
	    });
	  }
	};
	return AutoLaunchWindows;
}

var applescript = {};

var applescriptParser = {};

var hasRequiredApplescriptParser;

function requireApplescriptParser () {
	if (hasRequiredApplescriptParser) return applescriptParser;
	hasRequiredApplescriptParser = 1;
	(function (exports) {
		// 'parse' accepts a string that is expected to be the stdout stream of an
		// osascript invocation. It reads the fist char of the string to determine
		// the data-type of the result, and creates the appropriate type parser.
		exports.parse = function(str) {
		  if (str.length == 0) {
		    return;
		  }
		  
		  var rtn = parseFromFirstRemaining.call({
		    value: str,
		    index: 0
		  });
		  return rtn;
		};

		// Attemps to determine the data type of the next part of the String to
		// parse. The 'this' value has a Object with 'value' as the AppleScript
		// string to parse, and 'index' as the pointer to the current position
		// of parsing in the String. This Function does not need to be exported???
		function parseFromFirstRemaining() {
		  var cur = this.value[this.index];
		  switch(cur) {
		    case '{':
		      return exports.ArrayParser.call(this);
		    case '"':
		      return exports.StringParser.call(this);
		    case 'a':
		      if (this.value.substring(this.index, this.index+5) == 'alias') {
		        return exports.AliasParser.call(this);
		      }
		      break;
		    case '«':
		      if (this.value.substring(this.index, this.index+5) == '«data') {
		        return exports.DataParser.call(this);
		      }
		      break;
		  }
		  if (!isNaN(cur)) {
		    return exports.NumberParser.call(this);
		  }
		  return exports.UndefinedParser.call(this);
		}

		// Parses an AppleScript "alias", which is really just a reference to a
		// location on the filesystem, but formatted kinda weirdly.
		exports.AliasParser = function() {
		  this.index += 6;
		  return "/Volumes/" + exports.StringParser.call(this).replace(/:/g, "/");
		};

		// Parses an AppleScript Array. Which looks like {}, instead of JavaScript's [].
		exports.ArrayParser = function() {
		  var rtn = [],
		    cur = this.value[++this.index];
		  while (cur != '}') {
		    rtn.push(parseFromFirstRemaining.call(this));
		    if (this.value[this.index] == ',') this.index += 2;
		    cur = this.value[this.index];
		  }
		  this.index++;
		  return rtn;
		};

		// Parses «data » results into native Buffer instances.
		exports.DataParser = function() {
		  var body = exports.UndefinedParser.call(this);
		  body = body.substring(6, body.length-1);
		  var type = body.substring(0,4);
		  body = body.substring(4, body.length);
		  var buf = new Buffer(body.length/2);
		  var count = 0;
		  for (var i=0, l=body.length; i<l; i += 2) {
		    buf[count++] = parseInt(body[i]+body[i+1], 16);
		  }
		  buf.type = type;
		  return buf;
		};

		// Parses an AppleScript Number into a native JavaScript Number instance.
		exports.NumberParser = function() {
		  return Number(exports.UndefinedParser.call(this));
		};

		// Parses a standard AppleScript String. Which starts and ends with "" chars.
		// The \ char is the escape character, so anything after that is a valid part
		// of the resulting String.
		exports.StringParser = function(str) {
		  var rtn = "",
		    end = ++this.index,
		    cur = this.value[end++];
		  while(cur != '"') {
		    if (cur == '\\') {
		      rtn += this.value.substring(this.index, end-1);
		      this.index = end++;
		    }
		    cur = this.value[end++];
		  }
		  rtn += this.value.substring(this.index, end-1);
		  this.index = end;
		  return rtn;
		};

		// When the "parseFromFirstRemaining" function can't figure out the data type
		// of "str", then the UndefinedParser is used. It crams everything it sees
		// into a String, until it finds a ',' or a '}' or it reaches the end of data.
		var END_OF_TOKEN = /}|,|\n/;
		exports.UndefinedParser = function() {
		  var end = this.index, cur = this.value[end++];
		  while (!END_OF_TOKEN.test(cur)) {
		    cur = this.value[end++];
		  }
		  var rtn = this.value.substring(this.index, end-1);
		  this.index = end-1;
		  return rtn;
		}; 
	} (applescriptParser));
	return applescriptParser;
}

var hasRequiredApplescript;

function requireApplescript () {
	if (hasRequiredApplescript) return applescript;
	hasRequiredApplescript = 1;
	(function (exports) {
		var spawn = require$$2.spawn;
		exports.Parsers = requireApplescriptParser();
		var parse = exports.Parsers.parse;

		// Path to 'osascript'. By default search PATH.
		exports.osascript = "osascript";

		// Execute a *.applescript file.
		exports.execFile = function execFile(file, args, callback) {
		  if (!Array.isArray(args)) {
		    callback = args;
		    args = [];
		  }
		  return runApplescript(file, args, callback);
		};

		// Execute a String as AppleScript.
		exports.execString = function execString(str, callback) {
		  return runApplescript(str, callback);
		};



		function runApplescript(strOrPath, args, callback) {
		  var isString = false;
		  if (!Array.isArray(args)) {
		    callback = args;
		    args = [];
		    isString = true;
		  }

		  // args get added to the end of the args array
		  args.push("-ss"); // To output machine-readable text.
		  if (!isString) {
		    // The name of the file is the final arg if 'execFile' was called.
		    args.push(strOrPath);
		  }
		  var interpreter = spawn(exports.osascript, args);

		  bufferBody(interpreter.stdout);
		  bufferBody(interpreter.stderr);

		  interpreter.on('exit', function(code) {
		    var result = parse(interpreter.stdout.body);
		    var err;
		    if (code) {
		      // If the exit code was something other than 0, we're gonna
		      // return an Error object.
		      err = new Error(interpreter.stderr.body);
		      err.appleScript = strOrPath;
		      err.exitCode = code;
		    }
		    if (callback) {
		      callback(err, result, interpreter.stderr.body);
		    }
		  });

		  if (isString) {
		    // Write the given applescript String to stdin if 'execString' was called.
		    interpreter.stdin.write(strOrPath);
		    interpreter.stdin.end();
		  }
		}

		function bufferBody(stream) {
		  stream.body = "";
		  stream.setEncoding("utf8");
		  stream.on("data", function(chunk) { stream.body += chunk; });
		} 
	} (applescript));
	return applescript;
}

var untildify;
var hasRequiredUntildify;

function requireUntildify () {
	if (hasRequiredUntildify) return untildify;
	hasRequiredUntildify = 1;

	const home = require$$0$2.homedir();

	untildify = str => {
		if (typeof str !== 'string') {
			throw new TypeError(`Expected a string, got ${typeof str}`);
		}

		return home ? str.replace(/^~(?=$|\/|\\)/, home) : str;
	};
	return untildify;
}

var mkdirp;
var hasRequiredMkdirp;

function requireMkdirp () {
	if (hasRequiredMkdirp) return mkdirp;
	hasRequiredMkdirp = 1;
	var path = require$$1;
	var fs = require$$0$1;
	var _0777 = parseInt('0777', 8);

	mkdirp = mkdirP.mkdirp = mkdirP.mkdirP = mkdirP;

	function mkdirP (p, opts, f, made) {
	    if (typeof opts === 'function') {
	        f = opts;
	        opts = {};
	    }
	    else if (!opts || typeof opts !== 'object') {
	        opts = { mode: opts };
	    }
	    
	    var mode = opts.mode;
	    var xfs = opts.fs || fs;
	    
	    if (mode === undefined) {
	        mode = _0777;
	    }
	    if (!made) made = null;
	    
	    var cb = f || /* istanbul ignore next */ function () {};
	    p = path.resolve(p);
	    
	    xfs.mkdir(p, mode, function (er) {
	        if (!er) {
	            made = made || p;
	            return cb(null, made);
	        }
	        switch (er.code) {
	            case 'ENOENT':
	                /* istanbul ignore if */
	                if (path.dirname(p) === p) return cb(er);
	                mkdirP(path.dirname(p), opts, function (er, made) {
	                    /* istanbul ignore if */
	                    if (er) cb(er, made);
	                    else mkdirP(p, opts, cb, made);
	                });
	                break;

	            // In the case of any other error, just see if there's a dir
	            // there already.  If so, then hooray!  If not, then something
	            // is borked.
	            default:
	                xfs.stat(p, function (er2, stat) {
	                    // if the stat fails, then that's super weird.
	                    // let the original error be the failure reason.
	                    if (er2 || !stat.isDirectory()) cb(er, made);
	                    else cb(null, made);
	                });
	                break;
	        }
	    });
	}

	mkdirP.sync = function sync (p, opts, made) {
	    if (!opts || typeof opts !== 'object') {
	        opts = { mode: opts };
	    }
	    
	    var mode = opts.mode;
	    var xfs = opts.fs || fs;
	    
	    if (mode === undefined) {
	        mode = _0777;
	    }
	    if (!made) made = null;

	    p = path.resolve(p);

	    try {
	        xfs.mkdirSync(p, mode);
	        made = made || p;
	    }
	    catch (err0) {
	        switch (err0.code) {
	            case 'ENOENT' :
	                made = sync(path.dirname(p), opts, made);
	                sync(p, opts, made);
	                break;

	            // In the case of any other error, just see if there's a dir
	            // there already.  If so, then hooray!  If not, then something
	            // is borked.
	            default:
	                var stat;
	                try {
	                    stat = xfs.statSync(p);
	                }
	                catch (err1) /* istanbul ignore next */ {
	                    throw err0;
	                }
	                /* istanbul ignore if */
	                if (!stat.isDirectory()) throw err0;
	                break;
	        }
	    }

	    return made;
	};
	return mkdirp;
}

var fileBasedUtilities;
var hasRequiredFileBasedUtilities;

function requireFileBasedUtilities () {
	if (hasRequiredFileBasedUtilities) return fileBasedUtilities;
	hasRequiredFileBasedUtilities = 1;
	var fs, mkdirp;

	fs = require$$0$1;

	mkdirp = requireMkdirp();

	fileBasedUtilities = {

	  /* Public */
	  createFile: function(arg) {
	    var data, directory, filePath;
	    directory = arg.directory, filePath = arg.filePath, data = arg.data;
	    return new Promise(function(resolve, reject) {
	      return mkdirp(directory, function(mkdirErr) {
	        if (mkdirErr != null) {
	          return reject(mkdirErr);
	        }
	        return fs.writeFile(filePath, data, function(writeErr) {
	          if (writeErr != null) {
	            return reject(writeErr);
	          }
	          return resolve();
	        });
	      });
	    });
	  },
	  isEnabled: function(filePath) {
	    return new Promise((function(_this) {
	      return function(resolve, reject) {
	        return fs.stat(filePath, function(err, stat) {
	          if (err != null) {
	            return resolve(false);
	          }
	          return resolve(stat != null);
	        });
	      };
	    })());
	  },
	  removeFile: function(filePath) {
	    return new Promise((function(_this) {
	      return function(resolve, reject) {
	        return fs.stat(filePath, function(statErr) {
	          if (statErr != null) {
	            return resolve();
	          }
	          return fs.unlink(filePath, function(unlinkErr) {
	            if (unlinkErr != null) {
	              return reject(unlinkErr);
	            }
	            return resolve();
	          });
	        });
	      };
	    })());
	  }
	};
	return fileBasedUtilities;
}

var AutoLaunchMac;
var hasRequiredAutoLaunchMac;

function requireAutoLaunchMac () {
	if (hasRequiredAutoLaunchMac) return AutoLaunchMac;
	hasRequiredAutoLaunchMac = 1;
	var applescript, fileBasedUtilities, untildify,
	  indexOf = [].indexOf || function(item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i; } return -1; };

	applescript = requireApplescript();

	untildify = requireUntildify();

	fileBasedUtilities = requireFileBasedUtilities();

	AutoLaunchMac = {

	  /* Public */
	  enable: function(arg) {
	    var appName, appPath, data, isHiddenOnLaunch, isHiddenValue, mac, programArguments, programArgumentsSection, properties;
	    appName = arg.appName, appPath = arg.appPath, isHiddenOnLaunch = arg.isHiddenOnLaunch, mac = arg.mac;
	    if (mac.useLaunchAgent) {
	      programArguments = [appPath];
	      if (isHiddenOnLaunch) {
	        programArguments.push('--hidden');
	      }
	      programArgumentsSection = programArguments.map(function(argument) {
	        return "    <string>" + argument + "</string>";
	      }).join('\n');
	      data = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\">\n<dict>\n  <key>Label</key>\n  <string>" + appName + "</string>\n  <key>ProgramArguments</key>\n  <array>\n  " + programArgumentsSection + "\n  </array>\n  <key>RunAtLoad</key>\n  <true/>\n</dict>\n</plist>";
	      return fileBasedUtilities.createFile({
	        data: data,
	        directory: this.getDirectory(),
	        filePath: this.getFilePath(appName)
	      });
	    }
	    isHiddenValue = isHiddenOnLaunch ? 'true' : 'false';
	    properties = "{path:\"" + appPath + "\", hidden:" + isHiddenValue + ", name:\"" + appName + "\"}";
	    return this.execApplescriptCommand("make login item at end with properties " + properties);
	  },
	  disable: function(appName, mac) {
	    if (mac.useLaunchAgent) {
	      return fileBasedUtilities.removeFile(this.getFilePath(appName));
	    }
	    return this.execApplescriptCommand("delete login item \"" + appName + "\"");
	  },
	  isEnabled: function(appName, mac) {
	    if (mac.useLaunchAgent) {
	      return fileBasedUtilities.isEnabled(this.getFilePath(appName));
	    }
	    return this.execApplescriptCommand('get the name of every login item').then(function(loginItems) {
	      return (loginItems != null) && indexOf.call(loginItems, appName) >= 0;
	    });
	  },

	  /* Private */
	  execApplescriptCommand: function(commandSuffix) {
	    return new Promise(function(resolve, reject) {
	      return applescript.execString("tell application \"System Events\" to " + commandSuffix, function(err, result) {
	        if (err != null) {
	          return reject(err);
	        }
	        return resolve(result);
	      });
	    });
	  },
	  getDirectory: function() {
	    return untildify('~/Library/LaunchAgents/');
	  },
	  getFilePath: function(appName) {
	    return "" + (this.getDirectory()) + appName + ".plist";
	  }
	};
	return AutoLaunchMac;
}

var AutoLaunchLinux;
var hasRequiredAutoLaunchLinux;

function requireAutoLaunchLinux () {
	if (hasRequiredAutoLaunchLinux) return AutoLaunchLinux;
	hasRequiredAutoLaunchLinux = 1;
	var fileBasedUtilities, untildify;

	untildify = requireUntildify();

	fileBasedUtilities = requireFileBasedUtilities();

	AutoLaunchLinux = {

	  /* Public */
	  enable: function(arg) {
	    var appName, appPath, data, hiddenArg, isHiddenOnLaunch;
	    appName = arg.appName, appPath = arg.appPath, isHiddenOnLaunch = arg.isHiddenOnLaunch;
	    hiddenArg = isHiddenOnLaunch ? ' --hidden' : '';
	    data = "[Desktop Entry]\nType=Application\nVersion=1.0\nName=" + appName + "\nComment=" + appName + "startup script\nExec=" + appPath + hiddenArg + "\nStartupNotify=false\nTerminal=false";
	    return fileBasedUtilities.createFile({
	      data: data,
	      directory: this.getDirectory(),
	      filePath: this.getFilePath(appName)
	    });
	  },
	  disable: function(appName) {
	    return fileBasedUtilities.removeFile(this.getFilePath(appName));
	  },
	  isEnabled: function(appName) {
	    return fileBasedUtilities.isEnabled(this.getFilePath(appName));
	  },

	  /* Private */
	  getDirectory: function() {
	    return untildify('~/.config/autostart/');
	  },
	  getFilePath: function(appName) {
	    return "" + (this.getDirectory()) + appName + ".desktop";
	  }
	};
	return AutoLaunchLinux;
}

var dist;
var hasRequiredDist;

function requireDist () {
	if (hasRequiredDist) return dist;
	hasRequiredDist = 1;
	var isPathAbsolute,
	  bind = function(fn, me){ return function(){ return fn.apply(me, arguments); }; };

	isPathAbsolute = requirePathIsAbsolute();

	dist = (function() {

	  /* Public */
	  function AutoLaunch(arg) {
	    var isHidden, mac, name, path, versions;
	    name = arg.name, isHidden = arg.isHidden, mac = arg.mac, path = arg.path;
	    this.fixOpts = bind(this.fixOpts, this);
	    this.isEnabled = bind(this.isEnabled, this);
	    this.disable = bind(this.disable, this);
	    this.enable = bind(this.enable, this);
	    if (name == null) {
	      throw new Error('You must specify a name');
	    }
	    this.opts = {
	      appName: name,
	      isHiddenOnLaunch: isHidden != null ? isHidden : false,
	      mac: mac != null ? mac : {}
	    };
	    versions = typeof process !== "undefined" && process !== null ? process.versions : void 0;
	    if (path != null) {
	      if (!isPathAbsolute(path)) {
	        throw new Error('path must be absolute');
	      }
	      this.opts.appPath = path;
	    } else if ((versions != null) && ((versions.nw != null) || (versions['node-webkit'] != null) || (versions.electron != null))) {
	      this.opts.appPath = process.execPath;
	    } else {
	      throw new Error('You must give a path (this is only auto-detected for NW.js and Electron apps)');
	    }
	    this.fixOpts();
	    this.api = null;
	    if (/^win/.test(process.platform)) {
	      this.api = requireAutoLaunchWindows();
	    } else if (/darwin/.test(process.platform)) {
	      this.api = requireAutoLaunchMac();
	    } else if ((/linux/.test(process.platform)) || (/freebsd/.test(process.platform))) {
	      this.api = requireAutoLaunchLinux();
	    } else {
	      throw new Error('Unsupported platform');
	    }
	  }

	  AutoLaunch.prototype.enable = function() {
	    return this.api.enable(this.opts);
	  };

	  AutoLaunch.prototype.disable = function() {
	    return this.api.disable(this.opts.appName, this.opts.mac);
	  };

	  AutoLaunch.prototype.isEnabled = function() {
	    return this.api.isEnabled(this.opts.appName, this.opts.mac);
	  };


	  /* Private */

	  AutoLaunch.prototype.fixMacExecPath = function(path, macOptions) {
	    path = path.replace(/(^.+?[^\/]+?\.app)\/Contents\/(Frameworks\/((\1|[^\/]+?) Helper)\.app\/Contents\/MacOS\/\3|MacOS\/Electron)/, '$1');
	    if (!macOptions.useLaunchAgent) {
	      path = path.replace(/\.app\/Contents\/MacOS\/[^\/]*$/, '.app');
	    }
	    return path;
	  };

	  AutoLaunch.prototype.fixOpts = function() {
	    var tempPath;
	    this.opts.appPath = this.opts.appPath.replace(/\/$/, '');
	    if (/darwin/.test(process.platform)) {
	      this.opts.appPath = this.fixMacExecPath(this.opts.appPath, this.opts.mac);
	    }
	    if (this.opts.appPath.indexOf('/') !== -1) {
	      tempPath = this.opts.appPath.split('/');
	      this.opts.appName = tempPath[tempPath.length - 1];
	    } else if (this.opts.appPath.indexOf('\\') !== -1) {
	      tempPath = this.opts.appPath.split('\\');
	      this.opts.appName = tempPath[tempPath.length - 1];
	      this.opts.appName = this.opts.appName.substr(0, this.opts.appName.length - '.exe'.length);
	    }
	    if (/darwin/.test(process.platform)) {
	      if (this.opts.appName.indexOf('.app', this.opts.appName.length - '.app'.length) !== -1) {
	        return this.opts.appName = this.opts.appName.substr(0, this.opts.appName.length - '.app'.length);
	      }
	    }
	  };

	  return AutoLaunch;

	})();
	return dist;
}

var distExports = requireDist();
var index = /*@__PURE__*/getDefaultExportFromCjs(distExports);

module.exports = index;
