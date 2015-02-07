var _ = require('underscore'),
	async = require('async'),
	config = require('../config'),
	crypto = require('crypto'),
	etc = require('../etc'),
	exec = require('child_process').execFile,
	fs = require('fs'),
	gulp = require('../gulpfile'),
	hooks = require('../hooks'),
	imager = require('../imager/config'),
	path = require('path'),
	report = require('../report/config'),
	vm = require('vm');

_.templateSettings = {
	interpolate: /\{\{(.+?)\}\}/g
};

exports.emitter = new (require('events').EventEmitter);

exports.dbCache = {
	OPs: {},
	opTags: {},
	threadSubs: {},
	YAKUMAN: 0,
	funThread: 0,
	addresses: {},
	ranges: {},
};

var HOT = exports.hot = {};
var RES = exports.resources = {};
exports.clientConfig = [];
exports.clientConfigHash = '';
exports.clients = {};
exports.clientsByIP = {};

function reload_hot_config(cb) {
	fs.readFile('hot.js', 'UTF-8', function (err, js) {
		if (err)
			cb(err);
		var hot = {};
		try {
			vm.runInNewContext(js, hot);
		}
		catch (e) {
			return cb(e);
		}
		if (!hot || !hot.hot)
			return cb('Bad hot config.');

		// Overwrite the original object just in case
		Object.keys(HOT).forEach(function (k) {
			delete HOT[k];
		});
		_.extend(HOT, hot.hot);

		// Pass some of the config variables to the client
		// TODO: Once using gulp, could write this to the start of the client file instead
		var clientHot = _.pick(HOT, 'CUSTOM_BANNER_BOTTOM', 'ILLYA_DANCE', 'EIGHT_BALL', 'THREADS_PER_PAGE', 'THREAD_LAST_N',
      'ABBREVIATED_REPLIES', 'SUBJECT_MAX_LENGTH', 'EXCLUDE_REGEXP','ADMIN_ALIAS', 'MOD_ALIAS', 'SAGE_ENABLED');
		HOT.CLIENT_CONFIG = JSON.stringify(clientConfig);
		HOT.CLIENT_IMAGER = JSON.stringify(clientImager);
		HOT.CLIENT_REPORT = JSON.stringify(clientReport);
		HOT.CLIENT_HOT = JSON.stringify(clientHot);
		var combined = exports.clientConfig = [clientConfig, clientImager, clientReport, clientHot];
		exports.clientConfigHash = HOT.CLIENT_CONFIG_HASH = crypto.createHash('MD5')
				.update(JSON.stringify(combined)).digest('hex');

		read_exits('exits.txt', function () {
			hooks.trigger('reloadHot', HOT, cb);
		});
	});
}

var clientConfig = _.pick(config,'IP_MNEMONIC', 'GAME_BOARDS', 'USE_WEBSOCKETS', 'SOCKET_PATH', 'DEBUG', 'READ_ONLY');
var clientImager = _.pick(imager,'WEBM', 'AUDIOFILES', 'UPLOAD_URL','MEDIA_URL', 'THUMB_DIMENSIONS',
	'PINKY_DIMENSIONS', 'SPOILER_IMAGES', 'IMAGE_HATS');
var clientReport = _.pick(report, 'RECAPTCHA_PUBLIC_KEY');

function reload_scripts(cb) {
	// Read JSON files in ./state, generated by grunt-rev
	async.mapSeries(['client', 'vendor', 'mod'], function(name, callback){
		fs.readFile(path.join('state', name+'.json'), function(err, json){
			if (err)
				return callback(err);
			var js;
			try {
				js = JSON.parse(json);
			}
			catch (e) {
				return callback(e);
			}
			if (!js || !js[name])
				return callback('Bad state/'+name+'.json.');
			callback(null, js[name]);
		});
	}, function(err, js){
		if (err)
			return cb(err);
		HOT.CLIENT_JS = js[0];
		HOT.VENDOR_JS = js[1];
		// Read moderator js file
		fs.readFile(path.join('state', js[2]), 'UTF-8', function (err, modSrc) {
			if (err)
				return cb(err);
			RES.modJs = modSrc;
			cb(null);
		});
	});
}

function getScriptRevision(name, cb){

}

function reload_resources(cb) {

	var deps = require('../deps');

	read_templates(function (err, tmpls) {
		if (err)
			return cb(err);

		_.extend(RES, expand_templates(tmpls));

		hooks.trigger('reloadResources', RES, cb);
	});
}

function read_templates(cb) {
	function read(dir, file) {
		return fs.readFile.bind(fs, path.join(dir, file), 'UTF-8');
	}

	async.parallel({
		index: read('tmpl', 'index.html'),
		filter: read('tmpl', 'filter.html'),
		login: read('tmpl', 'login.html'),
    suggestionbox: read('tmpl', 'suggestionbox.html'),
		curfew: read('tmpl', 'curfew.html'),
		suspension: read('tmpl', 'suspension.html'),
		aLookup: read('tmpl', 'alookup.html'),
		notFound: read('www', '404.html'),
		serverError: read('www', '50x.html'),
	}, cb);
}

function expand_templates(res) {
	var templateVars = _.clone(HOT);
	_.extend(templateVars, imagerConfig);
	_.extend(templateVars, config);
	_.extend(templateVars, make_navigation_html());

	templateVars.FAQ = build_FAQ(templateVars.FAQ);
	// Format info banner
	if (templateVars.BANNERINFO)
		templateVars.BANNERINFO = '&nbsp;&nbsp;&nbsp;[' + templateVars.BANNERINFO + ']';

	function tmpl(data) {
		var expanded = _.template(data)(templateVars);
		return {tmpl: expanded.split(/\$[A-Z]+/),
			src: expanded};
	}

	var ex = {
		navigationHtml: make_navigation_html(),
		filterTmpl: tmpl(res.filter).tmpl,
		curfewTmpl: tmpl(res.curfew).tmpl,
		suspensionTmpl: tmpl(res.suspension).tmpl,
		loginTmpl: tmpl(res.login).tmpl,
    suggestionTmpl: tmpl(res.suggestionbox).tmpl,
		aLookupHtml: res.aLookup,
		notFoundHtml: res.notFound,
		serverErrorHtml: res.serverError,
	};

	var index = tmpl(res.index);
	ex.indexTmpl = index.tmpl;
	var hash = crypto.createHash('md5').update(index.src);
	ex.indexHash = hash.digest('hex').slice(0, 8);

	return ex;
}

function build_FAQ(faq){
	if (faq.length > 0){
		var list = ['<ul>'];
		faq.forEach(function(entry){
			list.push('<li>' + entry + '</li>');
		});
		list.push('<ul>');
		return list.join('');
	}
}

function buildClient(cb){
	// XXX: Reruns which each hot reload
	etc.which('gulp', function(gulp){
		exec(gulp, ['client', 'mod', 'vendor'], function(err, stdout, stderr){
			if (err)
				return console.error('Error: Failed to build client:', err, stderr);
			cb();
		});
	});
}

exports.reload_hot_resources = function (cb) {
	buildClient(function(){
		async.series([
			reload_hot_config,
			reload_scripts,
			reload_resources,
		], cb);
	});
};

function make_navigation_html() {
	if (!HOT.INTER_BOARD_NAVIGATION)
		return '';
	var bits = ['<b id="navTop">['];
	config.BOARDS.forEach(function (board, i) {
		if (board == config.STAFF_BOARD)
			return;
		if (i > 0)
			bits.push(' / ');
		bits.push('<a href="../'+board+'/">'+board+'</a>');
	});
	bits.push(']</b>');
	return bits.join('');
}

function read_exits(file, cb) {
	fs.readFile(file, 'UTF-8', function (err, lines) {
		if (err)
			return cb(err);
		var exits = [], dest = HOT.BANS;
		lines.split(/\n/g).forEach(function (line) {
			var m = line.match(/^(?:^#\d)*(\d+\.\d+\.\d+\.\d+)/);
			if (!m)
				return;
			var exit = m[1];
			if (dest.indexOf(exit) < 0)
				dest.push(exit);
		});
		cb(null);
	});
}
