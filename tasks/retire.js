/* jshint -W055 */
'use strict';

module.exports = function (grunt) {

   var retire = require('retire/lib/retire'),
      repo    = require('retire/lib/repo'),
      resolve = require('retire/lib/resolve'),
      log     = require('retire/lib/utils').log,
      scanner = require('retire/lib/scanner'),
      fs      = require('fs'),
      path    = require('path'),
      req     = require('request'),
      os      = require('os'),
      async   = require('async');

   grunt.registerMultiTask('retire', 'Scanner detecting the use of JavaScript libraries with known vulnerabilites.', function () {
      var done = this.async();
      var jsRepo = null;
      var nodeRepo = null;
      var vulnsFound = false;
      var filesSrc = this.filesSrc;
      var request = req;
      var defaultIgnoreFiles = ['.retireignore', '.retireignore.json'];
      var output = {};
      var scanedFile;

      var levels = {
          'none': 0,
          'critical': 1,
          'high': 2,
          'medium': 3,
          'low': 4,
          'all': 9999
      };
      var severity = 0;

      function taskVulnLogger(msg) {
         var keyValue;
         keyValue = scanedFile.slice(scanedFile.lastIndexOf('/') + 1);

         if (keyValue.indexOf('.') > -1) {
            keyValue = 'js.' + keyValue.slice(0, keyValue.indexOf('.'));
         }
         else {
            keyValue = 'node.' + keyValue;
         }
         if (!output.hasOwnProperty(keyValue)) {
            output[keyValue] = 1;
         }
         output[keyValue] = output[keyValue] + 1;
         return grunt.log.error(msg);
      }

      // Merge task-specific and/or target-specific options with these defaults.
      var options = this.options({
         verbose: true,
         packageOnly: false,
         jsRepository: 'https://raw.github.com/RetireJS/retire.js/master/repository/jsrepository.json',
         nodeRepository: 'https://raw.github.com/RetireJS/retire.js/master/repository/npmrepository.json',
         logger: grunt.log.writeln,
         warnlogger: taskVulnLogger,
         outputFile: false
      });
      var logger = log(options);

      // get numeric rank for severity
      severity = levels['all'];
      if('severity' in options) {
          severity = levels[options.severity];
      }

      if (!options.nocache) {
         options.cachedir = path.resolve(os.tmpdir(), '.retire-cache/');
      }
      var ignores = options.ignore ? options.ignore.split(',') : [];
      options.ignore = { paths : [], descriptors: [] };
      var defaultIgnoreFile = defaultIgnoreFiles.filter(function (x) {
         return fs.existsSync(x);
      })[0];

      if (!options.ignorefile && defaultIgnoreFile) {
        options.ignorefile = defaultIgnoreFile;
      }

      if(options.ignorefile) {
        if (!grunt.file.exists(options.ignorefile)) {
          grunt.log.error('Error: Could not read ignore file: ' + options.ignorefile);
          process.exit(1);
        }
        var ignored;
        if (options.ignorefile.substr(-5) === ".json") {
           ignored = JSON.parse(fs.readFileSync(options.ignorefile).toString());
           options.ignore.descriptors = ignored;
           var ignoredPaths = ignored.map(function (x) {
              return x.path;
           }).filter(function (x) {
              return x;
           });
           options.ignore.paths = options.ignore.paths.concat(ignoredPaths);
        } else {
           var lines = fs.readFileSync(options.ignorefile).toString().split(/\r\n|\n/g).filter(function(e) { return e !== ''; });
           ignored = lines.map(function(e) { return e[0] === '@' ? e.slice(1) : path.resolve(e); });
           options.ignore.paths = options.ignore.paths.concat(ignored);
        }
      }

      ignores.forEach(function(e) { options.ignore.paths.push(e); });
      logger.verbose("Ignoring " + JSON.stringify(options.ignore));

      // log (verbose) options before hooking in the reporter
      grunt.verbose.writeflags(options, 'Options');

      vulnsFound = false;
      // required to throw proper grunt error
      scanner.on('vulnerable-dependency-found', function(e) {
          e.results.forEach(function(result) {
              result.vulnerabilities.forEach(function(vulnerability) {
                  var sev = vulnerability.severity;
                  if(levels[sev] <= severity) {
                      vulnsFound = vulnsFound | true;
                  }
              });
          });
      });
      var events = [];
      function once(name, fun) {
         events.push(name);
         grunt.event.once(name, fun);
      }
      function on(name, fun) {
         events.push(name);
         grunt.event.on(name, fun);
      }


      once('retire-js-repo', function() {
         filesSrc.forEach(function(filepath) {
            if (!grunt.file.exists(filepath)) {
               grunt.log.debug('Skipping directory file:', filepath);
               return;               
            }
            if (!grunt.file.isFile(filepath)) {
               grunt.log.debug('Not a file:', filepath);
               return;               
            }
            scanedFile = filepath;
            if(options.verbose) {
               grunt.log.writeln('Checking:', filepath);
            }
            if (filepath.match(/\.js$/)) {
               scanner.scanJsFile(filepath, jsRepo, options);
            } else if (filepath.match(/\/bower.json$/)) {
               scanner.scanBowerFile(filepath, jsRepo, options);
            } else {
               grunt.log.debug('Unknown file type:', filepath);
            }
         }); 
         grunt.event.emit('retire-done');        
      });

      on('retire-node-scan', function(filesSrc) {
         if (filesSrc.length === 0) {
            grunt.event.emit('retire-done');
            return;
         }
         var filepath = filesSrc[0];
         if(grunt.file.exists(filepath + '/package.json')) {
            scanedFile = filepath.slice( 0, filepath.lastIndexOf('/') );
            if(options.verbose) {
               grunt.log.writeln('Checking:', filepath);
            }              
            resolve.getNodeDependencies(filepath, options.packageOnly).on('done', function(dependencies) {
               scanner.scanDependencies(dependencies, nodeRepo, options);
               grunt.event.emit('retire-node-scan', filesSrc.slice(1));        
           });
         } else {
            grunt.log.debug('Skipping. Could not find:', filepath + '/package.json');
            grunt.event.emit('retire-node-scan', filesSrc.slice(1));        
         }
      });

      once('retire-load-js', function() {
        var done = function (repo) {
             jsRepo = repo;
             grunt.event.emit('retire-js-repo');
        };

        if (/^http[s]?:/.test(options.jsRepository)) {
           repo.loadrepository(options.jsRepository, options).on('done', done);
        } else {
           repo.loadrepositoryFromFile(options.jsRepository, options).on('done', done);
        }

      });

      once('retire-load-node', function() {
         var done = function(repo) {
            nodeRepo = repo;
            grunt.event.emit('retire-node-scan', filesSrc);
         };

         if (/^http[s]?:/.test(options.nodeRepository)) {
            repo.loadrepository(options.nodeRepository, options).on('done', done);
         } else {
            repo.loadrepositoryFromFile(options.nodeRepository, options).on('done', done);
         }
      });

      once('retire-done', function() {
         if(!vulnsFound){
            if(!options.severity) {
                grunt.log.writeln('No vulnerabilities found.');
            }
            else if(options.severity === 'none') {
                grunt.log.writeln('Vulnerabilities ignored with severity set to none.');
            } else {
                grunt.log.writeln("No " + options.severity  + " vulnerabilities found.");
            }
         }
         events.forEach(function(e) {
            grunt.event.removeAllListeners(e);
         });
         if (options.outputFile) {
            grunt.file.write(options.outputFile, JSON.stringify(output));
         }
         done(!vulnsFound);
      });

      grunt.event.emit(this.target === 'node' ? 'retire-load-node' : 'retire-load-js');

   });

};
