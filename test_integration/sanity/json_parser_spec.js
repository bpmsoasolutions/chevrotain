(function(root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory(require('./json_parser'))
    }
    else if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['./json_parser.js'], factory)
    } else {
        factory(root.jsonParserModule)
    }
}(this, function(jsonParserModule) {

    describe('The Json Parser', function() {

        it('can parse a simple Json without errors', function() {
            var inputText = '{ "arr": [1,2,3], "obj": {"num":666}}'
            var lexAndParseResult = jsonParserModule.parseJson(inputText)

            expect(lexAndParseResult.lexErrors).to.be.empty
            expect(lexAndParseResult.parseErrors).to.be.empty
        })
    })
}))