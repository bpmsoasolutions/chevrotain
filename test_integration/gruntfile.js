// This grunt file can only run after chevrotain has been built.

var jsonTokens = require('./sanity/json_parser.js').jsonTokens
// Docs: we must extract all the Token names to prevent them from being minified.
var jsonTokenNames = jsonTokens.map(function(currTok) {
    return currTok.name
})

module.exports = function(grunt) {

    //noinspection UnnecessaryLabelJS
    grunt.initConfig({
        karma: {
            options: {
                configFile:  '../karma.conf.js',
                singleRun:   true,
                client:      {
                    captureConsole: true
                }
            },


            browsers_integration_tests_globals_all_minified: {
                options: {
                    port:       9985,
                    files: [
                        'lib/chevrotain.min.js',
                        'test/test.config.js',
                        'test_integration/sanity/json_parser.min.js',
                        'test_integration/**/*spec.js'
                    ]
                }
            }
        },

        uglify: {
            options: {
                mangle: {
                    // DOCS: prevents minification of Token names.
                    except: jsonTokenNames
                }
            },
            integration_tests_minified: {
                files: {
                    'sanity/json_parser.min.js': ['sanity/json_parser.js']
                }
            }
        },
    })

    // hack to load grunt tasks from parent node_modules
    // https://github.com/gruntjs/grunt/issues/696#issuecomment-63192649
    grunt.file.expand('../node_modules/grunt-*/tasks').forEach(grunt.loadTasks)

    grunt.registerTask('minifiy', 'uglify:integration_tests_minified')
    grunt.registerTask('test', "karma:browsers_integration_tests_globals_all_minified")

    grunt.registerTask('build', ["minifiy", "test"])
}
