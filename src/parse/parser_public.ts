import * as cache from "./cache"
import {exceptions} from "./exceptions_public"
import {
    classNameFromInstance,
    HashTable
} from "../lang/lang_extensions"
import {resolveGrammar} from "./grammar/resolver"
import {
    validateGrammar,
    validateRuleName,
    validateRuleDoesNotAlreadyExist,
    validateRuleIsOverridden
} from "./grammar/checks"
import {
    isEmpty,
    map,
    isArray,
    reduce,
    isObject,
    cloneObj,
    cloneArr,
    first,
    find,
    contains,
    flatten,
    last,
    dropRight,
    isFunction,
    has,
    isUndefined,
    forEach, some
} from "../utils/utils"
import {computeAllProdsFollows} from "./grammar/follow"
import {
    Token,
    tokenName,
    EOF,
    tokenLabel,
    hasTokenLabel
} from "../scan/tokens_public"
import {
    buildLookaheadForOption,
    buildLookaheadForMany,
    buildLookaheadForManySep,
    buildLookaheadForAtLeastOne,
    buildLookaheadForAtLeastOneSep,
    buildLookaheadFuncForOr,
    getLookaheadPathsForOr,
    getLookaheadPathsForOptionalProd, PROD_TYPE
} from "./grammar/lookahead"

import {TokenConstructor} from "../scan/lexer_public"
import {buildTopProduction} from "./gast_builder"
import {
    NextAfterTokenWalker,
    AbstractNextTerminalAfterProductionWalker,
    NextTerminalAfterAtLeastOneWalker,
    NextTerminalAfterAtLeastOneSepWalker,
    NextTerminalAfterManyWalker,
    NextTerminalAfterManySepWalker
} from "./grammar/interpreter"
import {IN} from "./constants"
import {gast} from "./grammar/gast_public"
import {cloneProduction} from "./grammar/gast"
import {ITokenGrammarPath} from "./grammar/path_public"

export enum ParserDefinitionErrorType {
    INVALID_RULE_NAME,
    DUPLICATE_RULE_NAME,
    INVALID_RULE_OVERRIDE,
    DUPLICATE_PRODUCTIONS,
    UNRESOLVED_SUBRULE_REF,
    LEFT_RECURSION,
    NONE_LAST_EMPTY_ALT,
    AMBIGUOUS_ALTS
}

export type IgnoredRuleIssues = { [dslNameAndOccurrence:string]:boolean }
export type IgnoredParserIssues = { [ruleName:string]:IgnoredRuleIssues }

const IN_RULE_RECOVERY_EXCEPTION = "InRuleRecoveryException"

export interface IParserConfig {
    /**
     * Is the error recovery / fault tolerance of the Chevrotain Parser enabled.
     */
    recoveryEnabled?:boolean,
    /**
     * Maximum number of tokens the parser will use to choose between alternatives.
     */
    maxLookahead?:number

    /**
     * Used to mark parser definition errors that should be ignored.
     * For example:
     *
     * {
     *   myCustomRule : {
     *                   OR3 : true
     *                  },
     *
     *   myOtherRule : {
     *                  OPTION1 : true,
     *                  OR4 : true
     *                 }
     * }
     *
     * Be careful when ignoring errors, they are usually there for a reason :).
     */
    ignoredIssues?:IgnoredParserIssues
}

const DEFAULT_PARSER_CONFIG:IParserConfig = Object.freeze({
    recoveryEnabled: false,
    maxLookahead:    5,
    ignoredIssues:   <any>{}
})

export interface IRuleConfig<T> {
    /**
     * The function which will be invoked to produce the returned value for a production that have not been
     * successfully executed and the parser recovered from.
     */
    recoveryValueFunc?:() => T

    /**
     * Enable/Disable re-sync error recovery for this specific production.
     */
    resyncEnabled?:boolean
}

const DEFAULT_RULE_CONFIG:IRuleConfig<any> = Object.freeze({
    recoveryValueFunc: () => undefined,
    resyncEnabled:     true
})

export interface IParserDefinitionError {
    message:string
    type:ParserDefinitionErrorType
    ruleName:string
}

export interface IParserDuplicatesDefinitionError extends IParserDefinitionError {
    dslName:string
    occurrence:number
    parameter?:string
}

export interface IParserEmptyAlternativeDefinitionError extends IParserDefinitionError {
    occurrence:number
    alternative:number
}

export interface IParserAmbiguousAlternativesDefinitionError extends IParserDefinitionError {
    occurrence:number
    alternatives:number[]
}

export interface IParserUnresolvedRefDefinitionError extends IParserDefinitionError {
    unresolvedRefName:string
}

// parameters needed to compute the key in the FOLLOW_SET map.
export interface IFollowKey {
    ruleName:string
    idxInCallingRule:number
    inRule:string
}

/**
 * OR([
 *  { WHEN:LA1, THEN_DO:XXX },
 *  { WHEN:LA2, THEN_DO:YYY },
 *  { WHEN:LA3, THEN_DO:ZZZ },
 * ])
 */
export interface IOrAlt<T> {
    WHEN:() => boolean
    // TODO: change THEN_DO property to ALT (may need to modify gast builder)
    THEN_DO:() => T
}

/**
 * OR([
 *  {ALT:XXX },
 *  {ALT:YYY },
 *  {ALT:ZZZ }
 * ])
 */
export interface IOrAltWithPredicate<T> {
    ALT:() => T
}

export type IAnyOrAlt<T> = IOrAlt<T> | IOrAltWithPredicate<T>

export interface IParserState {
    errors:exceptions.IRecognitionException[]
    lexerState:any
    RULE_STACK:string[]
}

export type Predicate = () => boolean
export type GrammarAction = () => void

/**
 * Convenience used to express an empty alternative in an OR (alternation).
 * can be used to more clearly describe the intent in a case of empty alternation.
 *
 * For example:
 *
 * 1. without using EMPTY_ALT:
 *
 *    this.OR([
 *      {ALT: () => {
 *        this.CONSUME1(OneTok)
 *        return "1"
 *      }},
 *      {ALT: () => {
 *        this.CONSUME1(TwoTok)
 *        return "2"
 *      }},
 *      {ALT: () => { // implicitly empty because there are no invoked grammar rules (OR/MANY/CONSUME...) inside this alternative.
 *        return "666"
 *      }},
 *    ])
 *
 *
 * 2. using EMPTY_ALT:
 *
 *    this.OR([
 *      {ALT: () => {
 *        this.CONSUME1(OneTok)
 *        return "1"
 *      }},
 *      {ALT: () => {
 *        this.CONSUME1(TwoTok)
 *        return "2"
 *      }},
 *      {ALT: EMPTY_ALT("666")}, // explicitly empty, clearer intent
 *    ])
 *
 */
export function EMPTY_ALT<T>(value:T = undefined):() => T {
    return function () {
        return value
    }
}

let EOF_FOLLOW_KEY:any = {}

/**
 * A Recognizer capable of self analysis to determine it's grammar structure
 * This is used for more advanced features requiring such information.
 * For example: Error Recovery, Automatic lookahead calculation.
 */
export class Parser {

    static NO_RESYNC:boolean = false
    // Set this flag to true if you don't want the Parser to throw error when problems in it's definition are detected.
    // (normally during the parser's constructor).
    // This is a design time flag, it will not affect the runtime error handling of the parser, just design time errors,
    // for example: duplicate rule names, referencing an unresolved subrule, ect...
    // This flag should not be enabled during normal usage, it is used in special situations, for example when
    // needing to display the parser definition errors in some GUI(online playground).
    static DEFER_DEFINITION_ERRORS_HANDLING:boolean = false

    protected static performSelfAnalysis(parserInstance:Parser) {
        let definitionErrors = []
        let defErrorsMsgs

        let className = classNameFromInstance(parserInstance)

        if (className === "") {
            // just a simple "throw Error" without any fancy "definition error" because the logic below relies on a unique parser name to
            // save/access those definition errors...
            throw Error("A Parser's constructor may not be an anonymous Function, it must be a named function\n" +
                "The constructor's name is used at runtime for performance (caching) purposes.")
        }

        // this information should only be computed once
        if (!cache.CLASS_TO_SELF_ANALYSIS_DONE.containsKey(className)) {
            cache.CLASS_TO_SELF_ANALYSIS_DONE.put(className, true)

            let orgProductions = parserInstance._productions
            let clonedProductions = new HashTable<gast.Rule>()
            // clone the grammar productions to support grammar inheritance. requirements:
            // 1. We want to avoid rebuilding the grammar every time so a cache for the productions is used.
            // 2. We need to collect the production from multiple grammars in an inheritance scenario during constructor invocation
            //    so the myGast variable is used.
            // 3. If a Production has been overridden references to it in the GAST must also be updated.
            forEach(orgProductions.keys(), (key) => {
                let value = orgProductions.get(key)
                clonedProductions.put(key, cloneProduction(value))
            })
            cache.getProductionsForClass(className).putAll(clonedProductions)

            // assumes this cache has been initialized (in the relevant parser's constructor)
            // TODO: consider making the self analysis a member method to resolve this.
            // that way it won't be callable before the constructor has been invoked...
            definitionErrors = cache.CLASS_TO_DEFINITION_ERRORS.get(className)

            let resolverErrors = resolveGrammar(clonedProductions)
            definitionErrors.push.apply(definitionErrors, resolverErrors) // mutability for the win?

            // only perform additional grammar validations IFF no resolving errors have occurred.
            // as unresolved grammar may lead to unhandled runtime exceptions in the follow up validations.
            if (isEmpty(resolverErrors)) {
                let validationErrors = validateGrammar(
                    clonedProductions.values(),
                    parserInstance.maxLookahead,
                    parserInstance.ignoredIssues)

                definitionErrors.push.apply(definitionErrors, validationErrors) // mutability for the win?
            }

            if (!isEmpty(definitionErrors) && !Parser.DEFER_DEFINITION_ERRORS_HANDLING) {
                defErrorsMsgs = map(definitionErrors, defError => defError.message)
                throw new Error(`Parser Definition Errors detected\n: ${defErrorsMsgs.join("\n-------------------------------\n")}`)
            }
            if (isEmpty(definitionErrors)) { // this analysis may fail if the grammar is not perfectly valid
                let allFollows = computeAllProdsFollows(clonedProductions.values())
                cache.setResyncFollowsForClass(className, allFollows)
            }
        }

        // reThrow the validation errors each time an erroneous parser is instantiated
        if (!isEmpty(cache.CLASS_TO_DEFINITION_ERRORS.get(className)) && !Parser.DEFER_DEFINITION_ERRORS_HANDLING) {
            defErrorsMsgs = map(cache.CLASS_TO_DEFINITION_ERRORS.get(className), defError => defError.message)
            throw new Error(`Parser Definition Errors detected\n: ${defErrorsMsgs.join("\n-------------------------------\n")}`)
        }
    }

    public errors:exceptions.IRecognitionException[] = []

    /**
     * This flag enables or disables error recovery (fault tolerance) of the parser.
     * If this flag is disabled the parser will halt on the first error.
     */
    protected recoveryEnabled:boolean
    protected maxLookahead:number
    protected ignoredIssues:IgnoredParserIssues

    protected _input:Token[] = []
    protected inputIdx = -1
    protected isBackTrackingStack = []
    protected className:string
    protected RULE_STACK:string[] = []
    protected RULE_OCCURRENCE_STACK:number[] = []
    protected tokensMap:{ [fqn:string]:Function } = undefined

    private firstAfterRepMap
    private classLAFuncs
    private definitionErrors:IParserDefinitionError[]
    private orLookaheadKeys:HashTable<string>[]
    private manyLookaheadKeys:HashTable<string>[]
    private manySepLookaheadKeys:HashTable<string>[]
    private atLeastOneSepLookaheadKeys:HashTable<string>[]
    private atLeastOneLookaheadKeys:HashTable<string>[]
    private optionLookaheadKeys:HashTable<string>[]
    private definedRulesNames:string[] = []

    /**
     * Only used internally for storing productions as they are built for the first time.
     * The final productions should be accessed from the static cache.
     */
    private _productions:HashTable<gast.Rule> = new HashTable<gast.Rule>()

    constructor(input:Token[], tokensMapOrArr:{ [fqn:string]:Function; } | Function[],
                config:IParserConfig = DEFAULT_PARSER_CONFIG) {
        this._input = input

        // configuration
        this.recoveryEnabled = has(config, "recoveryEnabled") ?
            config.recoveryEnabled :
            DEFAULT_PARSER_CONFIG.recoveryEnabled

        this.maxLookahead = has(config, "maxLookahead") ?
            config.maxLookahead :
            DEFAULT_PARSER_CONFIG.maxLookahead

        this.ignoredIssues = has(config, "ignoredIssues") ?
            config.ignoredIssues :
            DEFAULT_PARSER_CONFIG.ignoredIssues

        this.className = classNameFromInstance(this)
        this.firstAfterRepMap = cache.getFirstAfterRepForClass(this.className)
        this.classLAFuncs = cache.getLookaheadFuncsForClass(this.className)

        if (!cache.CLASS_TO_DEFINITION_ERRORS.containsKey(this.className)) {
            this.definitionErrors = []
            cache.CLASS_TO_DEFINITION_ERRORS.put(this.className, this.definitionErrors)
        }
        else {
            this.definitionErrors = cache.CLASS_TO_DEFINITION_ERRORS.get(this.className)
        }

        if (isArray(tokensMapOrArr)) {
            this.tokensMap = <any>reduce(<any>tokensMapOrArr, (acc, tokenClazz:Function) => {
                acc[tokenName(tokenClazz)] = tokenClazz
                return acc
            }, {})
        }
        else if (isObject(tokensMapOrArr)) {
            this.tokensMap = cloneObj(tokensMapOrArr)
        }
        else {
            throw new Error("'tokensMapOrArr' argument must be An Array of Token constructors or a Dictionary of Tokens.")
        }

        // always add EOF to the tokenNames -> constructors map. it is useful to assure all the input has been
        // parsed with a clear error message ("expecting EOF but found ...")
        this.tokensMap[tokenName(EOF)] = EOF

        if (cache.CLASS_TO_OR_LA_CACHE[this.className] === undefined) {
            cache.initLookAheadKeyCache(this.className)
        }

        this.orLookaheadKeys = cache.CLASS_TO_OR_LA_CACHE[this.className]
        this.manyLookaheadKeys = cache.CLASS_TO_MANY_LA_CACHE[this.className]
        this.manySepLookaheadKeys = cache.CLASS_TO_MANY_SEP_LA_CACHE[this.className]
        this.atLeastOneLookaheadKeys = cache.CLASS_TO_AT_LEAST_ONE_LA_CACHE[this.className]
        this.atLeastOneSepLookaheadKeys = cache.CLASS_TO_AT_LEAST_ONE_SEP_LA_CACHE[this.className]
        this.optionLookaheadKeys = cache.CLASS_TO_OPTION_LA_CACHE[this.className]
    }

    public set input(newInput:Token[]) {
        this.reset()
        this._input = newInput
    }

    public get input():Token[] {
        return cloneArr(this._input)
    }

    public reset():void {
        this.resetLexerState()

        this.isBackTrackingStack = []
        this.errors = []
        this._input = []
        this.RULE_STACK = []
        this.RULE_OCCURRENCE_STACK = []
    }

    public isAtEndOfInput():boolean {
        return this.LA(1) instanceof EOF
    }

    public getGAstProductions():HashTable<gast.Rule> {
        return cache.getProductionsForClass(this.className)
    }

    protected isBackTracking():boolean {
        return !(isEmpty(this.isBackTrackingStack))
    }

    protected SAVE_ERROR(error:exceptions.IRecognitionException):exceptions.IRecognitionException {
        if (exceptions.isRecognitionException(error)) {
            error.context = {
                ruleStack:           cloneArr(this.RULE_STACK),
                ruleOccurrenceStack: cloneArr(this.RULE_OCCURRENCE_STACK)
            }
            this.errors.push(error)
            return error
        }
        else {
            throw Error("Trying to save an Error which is not a RecognitionException")
        }
    }

    /**
     * @param grammarRule - The rule to try and parse in backtracking mode.
     * @param isValid - A predicate that given the result of the parse attempt will "decide" if the parse was successfully or not.
     *
     * @return {Function():boolean} a lookahead function that will try to parse the given grammarRule and will return true if succeed.
     */
    protected BACKTRACK<T>(grammarRule:(...args) => T, isValid:(T) => boolean):() => boolean {
        return function () {
            // save org state
            this.isBackTrackingStack.push(1)
            let orgState = this.saveRecogState()
            try {
                let ruleResult = grammarRule.call(this)
                return isValid(ruleResult)
            } catch (e) {
                if (exceptions.isRecognitionException(e)) {
                    return false
                }
                else {
                    throw e
                }
            }
            finally {
                this.reloadRecogState(orgState)
                this.isBackTrackingStack.pop()
            }
        }
    }

    // skips a token and returns the next token
    protected SKIP_TOKEN():Token {
        // example: assume 45 tokens in the input, if input index is 44 it means that NEXT_TOKEN will return
        // input[45] which is the 46th item and no longer exists,
        // so in this case the largest valid input index is 43 (input.length - 2 )
        if (this.inputIdx <= this._input.length - 2) {
            this.consumeToken()
            return this.LA(1)
        }
        else {
            return new EOF()
        }
    }

    // Parsing DSL
    /**
     * Convenience method equivalent to CONSUME1.
     * @see CONSUME1
     */
    protected CONSUME(tokClass:Function):Token {
        return this.CONSUME1(tokClass)
    }

    /**
     *
     * A Parsing DSL method use to consume a single terminal Token.
     * a Token will be consumed, IFF the next token in the token vector is an instanceof tokClass.
     * otherwise the parser will attempt to perform error recovery.
     *
     * The index in the method name indicates the unique occurrence of a terminal consumption
     * inside a the top level rule. What this means is that if a terminal appears
     * more than once in a single rule, each appearance must have a difference index.
     *
     * for example:
     *
     * function parseQualifiedName() {
     *    this.CONSUME1(Identifier);
     *    this.MANY(()=> {
     *       this.CONSUME1(Dot);
     *       this.CONSUME2(Identifier); // <-- here we use CONSUME2 because the terminal
     *    });                           //     'Identifier' has already appeared previously in the
     *                                  //     the rule 'parseQualifiedName'
     * }
     *
     * @param {Function} tokClass - A constructor function specifying the type of token to be consumed.
     *
     * @returns {Token} - The consumed token.
     */
    protected CONSUME1(tokClass:Function):Token {
        return this.consumeInternal(tokClass, 1)
    }

    /**
     * @see CONSUME1
     */
    protected CONSUME2(tokClass:Function):Token {
        return this.consumeInternal(tokClass, 2)
    }

    /**
     * @see CONSUME1
     */
    protected CONSUME3(tokClass:Function):Token {
        return this.consumeInternal(tokClass, 3)
    }

    /**
     * @see CONSUME1
     */
    protected CONSUME4(tokClass:Function):Token {
        return this.consumeInternal(tokClass, 4)
    }

    /**
     * @see CONSUME1
     */
    protected CONSUME5(tokClass:Function):Token {
        return this.consumeInternal(tokClass, 5)
    }

    /**
     * Convenience method equivalent to SUBRULE1
     * @see SUBRULE1
     */
    protected SUBRULE<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return this.SUBRULE1(ruleToCall, args)
    }

    /**
     * The Parsing DSL Method is used by one rule to call another.
     *
     * This may seem redundant as it does not actually do much.
     * However using it is mandatory for all sub rule invocations.
     * calling another rule without wrapping in SUBRULE(...)
     * will cause errors/mistakes in the Recognizer's self analysis,
     * which will lead to errors in error recovery/automatic lookahead calculation
     * and any other functionality relying on the Recognizer's self analysis
     * output.
     *
     * As in CONSUME the index in the method name indicates the occurrence
     * of the sub rule invocation in its rule.
     *
     * @param {Function} ruleToCall - The rule to invoke.
     * @param {*[]} args - The arguments to pass to the invoked subrule.
     * @returns {*} - The result of invoking ruleToCall.
     */
    protected SUBRULE1<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return ruleToCall.call(this, 1, args)
    }

    /**
     * @see SUBRULE1
     */
    protected SUBRULE2<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return ruleToCall.call(this, 2, args)
    }

    /**
     * @see SUBRULE1
     */
    protected SUBRULE3<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return ruleToCall.call(this, 3, args)
    }

    /**
     * @see SUBRULE1
     */
    protected SUBRULE4<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return ruleToCall.call(this, 4, args)
    }

    /**
     * @see SUBRULE1
     */
    protected SUBRULE5<T>(ruleToCall:(number) => T, args:any[] = []):T {
        return ruleToCall.call(this, 5, args)
    }

    /**
     * Convenience method equivalent to OPTION1.
     * @see OPTION1
     */
    protected OPTION(predicateOrAction:Predicate | GrammarAction,
                     action?:GrammarAction):boolean {
        return this.OPTION1.call(this, predicateOrAction, action)
    }

    /**
     * Parsing DSL Method that Indicates an Optional production
     * in EBNF notation: [...].
     *
     * Note that the 'action' param is optional. so both of the following forms are valid:
     *
     * - short: this.OPTION(()=>{ this.CONSUME(Digit});
     * - long: this.OPTION(predicateFunc, ()=>{ this.CONSUME(Digit});
     *
     * The 'predicateFunc' in the long form can be used to add constraints (none grammar related)
     * to optionally invoking the grammar action.
     *
     * As in CONSUME the index in the method name indicates the occurrence
     * of the optional production in it's top rule.
     *
     * @param {Function} predicateOrAction - The predicate / gate function that implements the constraint on the grammar
     *                                       or the grammar action to optionally invoke once.
     * @param {Function} [action] - The action to optionally invoke.
     *
     * @returns {boolean} - True iff the OPTION's action has been invoked
     */
    protected OPTION1(predicateOrAction:Predicate | GrammarAction,
                      action?:GrammarAction):boolean {
        return this.optionInternal(predicateOrAction, action, 1)
    }

    /**
     * @see OPTION1
     */
    protected OPTION2(predicateOrAction:Predicate | GrammarAction,
                      action?:GrammarAction):boolean {
        return this.optionInternal(predicateOrAction, action, 2)
    }

    /**
     * @see OPTION1
     */
    protected OPTION3(predicateOrAction:Predicate | GrammarAction,
                      action?:GrammarAction):boolean {
        return this.optionInternal(predicateOrAction, action, 3)
    }

    /**
     * @see OPTION1
     */
    protected OPTION4(predicateOrAction:Predicate | GrammarAction,
                      action?:GrammarAction):boolean {
        return this.optionInternal(predicateOrAction, action, 4)
    }

    /**
     * @see OPTION1
     */
    protected OPTION5(predicateOrAction:Predicate | GrammarAction,
                      action?:GrammarAction):boolean {
        return this.optionInternal(predicateOrAction, action, 5)
    }

    /**
     * Convenience method equivalent to OR1.
     * @see OR1
     */
    protected OR<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.OR1(alts, errMsgTypes)
    }

    /**
     * Parsing DSL method that indicates a choice between a set of alternatives must be made.
     * This is equivalent to EBNF alternation (A | B | C | D ...)
     *
     * There are two forms:
     *
     * - short: this.OR([
     *           {ALT:()=>{this.CONSUME(One)}},
     *           {ALT:()=>{this.CONSUME(Two)}},
     *           {ALT:()=>{this.CONSUME(Three)}},
     *        ], "a number")
     *
     * - long: this.OR([
     *           {WHEN: predicateFunc1, THEN_DO:()=>{this.CONSUME(One)}},
     *           {WHEN: predicateFuncX, THEN_DO:()=>{this.CONSUME(Two)}},
     *           {WHEN: predicateFuncX, THEN_DO:()=>{this.CONSUME(Three)}},
     *        ], "a number")
     *
     * They can also be mixed:
     * mixed: this.OR([
     *           {WHEN: predicateFunc1, THEN_DO:()=>{this.CONSUME(One)}},
     *           {ALT:()=>{this.CONSUME(Two)}},
     *           {ALT:()=>{this.CONSUME(Three)}}
     *        ], "a number")
     *
     * The 'predicateFuncX' in the long form can be used to add constraints (none grammar related) to choosing the alternative.
     *
     * As in CONSUME the index in the method name indicates the occurrence
     * of the alternation production in it's top rule.
     *
     * @param {{ALT:Function}[] | {WHEN:Function, THEN_DO:Function}[]} alts - An array of alternatives.
     *
     * @param {string} [errMsgTypes] - A description for the alternatives used in error messages
     *                                 If none is provided, the error message will include the names of the expected
     *                                 Tokens sequences which may start each alternative.
     *
     * @returns {*} - The result of invoking the chosen alternative.
     */
    protected OR1<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.orInternal(alts, errMsgTypes, 1)
    }

    /**
     * @see OR1
     */
    protected OR2<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.orInternal(alts, errMsgTypes, 2)
    }

    /**
     * @see OR1
     */
    protected OR3<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.orInternal(alts, errMsgTypes, 3)
    }

    /**
     * @see OR1
     */
    protected OR4<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.orInternal(alts, errMsgTypes, 4)
    }

    /**
     * @see OR1
     */
    protected OR5<T>(alts:IAnyOrAlt<T>[], errMsgTypes?:string):T {
        return this.orInternal(alts, errMsgTypes, 5)
    }

    /**
     * Convenience method equivalent to MANY1.
     * @see MANY1
     */
    protected MANY(predicateOrAction:Predicate | GrammarAction,
                   action?:GrammarAction):void {
        return this.MANY1.call(this, predicateOrAction, action)
    }

    /**
     * Parsing DSL method, that indicates a repetition of zero or more.
     * This is equivalent to EBNF repetition {...}.
     *
     * Note that the 'action' param is optional. so both of the following forms are valid:
     *
     * short: this.MANY(()=>{
     *                       this.CONSUME(Comma};
     *                       this.CONSUME(Digit});
     *
     * long: this.MANY(predicateFunc, () => {
     *                       this.CONSUME(Comma};
     *                       this.CONSUME(Digit});
     *
     * The 'predicateFunc' in the long form can be used to add constraints (none grammar related) taking another iteration.
     *
     * As in CONSUME the index in the method name indicates the occurrence
     * of the repetition production in it's top rule.
     *
     * @param {Function} predicateOrAction - The predicate / gate function that implements the constraint on the grammar
     *                                   or the grammar action to optionally invoke multiple times.
     * @param {Function} [action] - The action to optionally invoke multiple times.
     */
    protected MANY1(predicateOrAction:Predicate | GrammarAction,
                    action?:GrammarAction):void {
        this.manyInternal(this.MANY1, "MANY1", 1, predicateOrAction, action)
    }

    /**
     * @see MANY1
     */
    protected MANY2(predicateOrAction:Predicate | GrammarAction,
                    action?:GrammarAction):void {
        this.manyInternal(this.MANY2, "MANY2", 2, predicateOrAction, action)
    }

    /**
     * @see MANY1
     */
    protected MANY3(predicateOrAction:Predicate | GrammarAction,
                    action?:GrammarAction):void {
        this.manyInternal(this.MANY3, "MANY3", 3, predicateOrAction, action)
    }

    /**
     * @see MANY1
     */
    protected MANY4(predicateOrAction:Predicate | GrammarAction,
                    action?:GrammarAction):void {
        this.manyInternal(this.MANY4, "MANY4", 4, predicateOrAction, action)
    }

    /**
     * @see MANY1
     */
    protected MANY5(predicateOrAction:Predicate | GrammarAction,
                    action?:GrammarAction):void {
        this.manyInternal(this.MANY5, "MANY5", 5, predicateOrAction, action)
    }

    /**
     * Convenience method equivalent to MANY_SEP1.
     * @see MANY_SEP1
     */
    protected MANY_SEP(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.MANY_SEP1.call(this, separator, action)
    }

    /**
     * Parsing DSL method, that indicates a repetition of zero or more with a separator
     * Token between the repetitions.
     *
     * Example:
     *
     * this.MANY_SEP(Comma, () => {
     *                     this.CONSUME(Number};
     *                     ...
     *                   );
     *
     * Note that for the purposes of deciding on whether or not another iteration exists
     * Only a single Token is examined (The separator). Therefore if the grammar being implemented is
     * so "crazy" to require multiple tokens to identify an item separator please use the basic DSL methods
     * to implement it.
     *
     * As in CONSUME the index in the method name indicates the occurrence
     * of the repetition production in it's top rule.
     *
     * @param {TokenConstructor} separator - The Token class which will be used as a separator between repetitions.
     * @param {Function} [action] - The action to optionally invoke.
     *
     * @return {Token[]} - The consumed separator Tokens.
     */
    protected MANY_SEP1(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.manySepFirstInternal(this.MANY_SEP1, "MANY_SEP1", 1, separator, action)
    }

    /**
     * @see MANY_SEP1
     */
    protected MANY_SEP2(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.manySepFirstInternal(this.MANY_SEP2, "MANY_SEP2", 2, separator, action)
    }

    /**
     * @see MANY_SEP1
     */
    protected MANY_SEP3(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.manySepFirstInternal(this.MANY_SEP3, "MANY_SEP3", 3, separator, action)
    }

    /**
     * @see MANY_SEP1
     */
    protected MANY_SEP4(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.manySepFirstInternal(this.MANY_SEP4, "MANY_SEP4", 4, separator, action)
    }

    /**
     * @see MANY_SEP1
     */
    protected MANY_SEP5(separator:TokenConstructor, action:GrammarAction):Token[] {
        return this.manySepFirstInternal(this.MANY_SEP5, "MANY_SEP5", 5, separator, action)
    }

    /**
     * Convenience method equivalent to AT_LEAST_ONE1.
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE(predicateOrAction:Predicate | GrammarAction,
                           action?:GrammarAction | string,
                           errMsg?:string):void {
        return this.AT_LEAST_ONE1.call(this, predicateOrAction, action, errMsg)
    }

    /**
     * Convenience method, same as MANY but the repetition is of one or more.
     * failing to match at least one repetition will result in a parsing error and
     * cause the parser to attempt error recovery.
     *
     * @see MANY1
     *
     * @param {Function} predicateOrAction  - The predicate / gate function that implements the constraint on the grammar
     *                                        or the grammar action to invoke at least once.
     * @param {Function} [action] - The action to optionally invoke.
     * @param {string} [errMsg] - Short title/classification to what is being matched.
     */
    protected AT_LEAST_ONE1(predicateOrAction:Predicate | GrammarAction,
                            action?:GrammarAction | string,
                            errMsg?:string):void {
        this.atLeastOneInternal(this.AT_LEAST_ONE1, "AT_LEAST_ONE1", 1, predicateOrAction, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE2(predicateOrAction:Predicate | GrammarAction,
                            action?:GrammarAction | string,
                            errMsg?:string):void {
        this.atLeastOneInternal(this.AT_LEAST_ONE2, "AT_LEAST_ONE2", 2, predicateOrAction, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE3(predicateOrAction:Predicate | GrammarAction,
                            action?:GrammarAction | string,
                            errMsg?:string):void {
        this.atLeastOneInternal(this.AT_LEAST_ONE3, "AT_LEAST_ONE3", 3, predicateOrAction, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE4(predicateOrAction:Predicate | GrammarAction,
                            action?:GrammarAction | string,
                            errMsg?:string):void {
        this.atLeastOneInternal(this.AT_LEAST_ONE4, "AT_LEAST_ONE4", 4, predicateOrAction, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE5(predicateOrAction:Predicate | GrammarAction,
                            action?:GrammarAction | string,
                            errMsg?:string):void {
        this.atLeastOneInternal(this.AT_LEAST_ONE5, "AT_LEAST_ONE5", 5, predicateOrAction, action, errMsg)
    }

    /**
     * Convenience method equivalent to AT_LEAST_ONE_SEP1.
     * @see AT_LEAST_ONE1
     */
    protected AT_LEAST_ONE_SEP(separator:TokenConstructor,
                               action:GrammarAction | string,
                               errMsg?:string):Token[] {
        return this.AT_LEAST_ONE_SEP1.call(this, separator, action, errMsg)
    }

    /**
     *
     * Convenience method, same as MANY_SEP but the repetition is of one or more.
     * failing to match at least one repetition will result in a parsing error and
     * cause the parser to attempt error recovery.
     *
     * @see MANY_SEP1
     *
     * @param {TokenConstructor} separator - The Token class which will be used as a separator between repetitions.
     * @param {Function} [action] - The action to optionally invoke.
     * @param {string} [errMsg] - Short title/classification to what is being matched.
     */
    protected AT_LEAST_ONE_SEP1(separator:TokenConstructor,
                                action:GrammarAction | string,
                                errMsg?:string):Token[] {
        return this.atLeastOneSepFirstInternal(this.atLeastOneSepFirstInternal, "AT_LEAST_ONE_SEP1", 1, separator, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE_SEP1
     */
    protected AT_LEAST_ONE_SEP2(separator:TokenConstructor,
                                action:GrammarAction | string,
                                errMsg?:string):Token[] {
        return this.atLeastOneSepFirstInternal(this.atLeastOneSepFirstInternal, "AT_LEAST_ONE_SEP2", 2, separator, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE_SEP1
     */
    protected AT_LEAST_ONE_SEP3(separator:TokenConstructor,
                                action:GrammarAction | string,
                                errMsg?:string):Token[] {
        return this.atLeastOneSepFirstInternal(this.atLeastOneSepFirstInternal, "AT_LEAST_ONE_SEP3", 3, separator, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE_SEP1
     */
    protected AT_LEAST_ONE_SEP4(separator:TokenConstructor,
                                action:GrammarAction | string,
                                errMsg?:string):Token[] {
        return this.atLeastOneSepFirstInternal(this.atLeastOneSepFirstInternal, "AT_LEAST_ONE_SEP4", 4, separator, action, errMsg)
    }

    /**
     * @see AT_LEAST_ONE_SEP1
     */
    protected AT_LEAST_ONE_SEP5(separator:TokenConstructor,
                                action:GrammarAction | string,
                                errMsg?:string):Token[] {
        return this.atLeastOneSepFirstInternal(this.atLeastOneSepFirstInternal, "AT_LEAST_ONE_SEP5", 5, separator, action, errMsg)
    }

    /**
     *
     * @param {string} name - The name of the rule.
     * @param {Function} implementation - The implementation of the rule.
     * @param {IRuleConfig} [config] - The rule's optional configuration.
     *
     * @returns {Function} - The parsing rule which is the production implementation wrapped with the parsing logic that handles
     *                     Parser state / error recovery&reporting/ ...
     */
    protected RULE<T>(name:string,
                      implementation:(...implArgs:any[]) => T,
                      config:IRuleConfig<T> = DEFAULT_RULE_CONFIG):(idxInCallingRule?:number, ...args:any[]) => T {

        let ruleErrors = validateRuleName(name, this.className)
        ruleErrors = ruleErrors.concat(validateRuleDoesNotAlreadyExist(name, this.definedRulesNames, this.className))
        this.definedRulesNames.push(name)
        this.definitionErrors.push.apply(this.definitionErrors, ruleErrors) // mutability for the win

        // only build the gast representation once.
        if (!(this._productions.containsKey(name))) {
            let gastProduction = buildTopProduction(implementation.toString(), name, this.tokensMap)
            this._productions.put(name, gastProduction)
        }
        else {
            let parserClassProductions = cache.getProductionsForClass(this.className)
            let cachedProduction = parserClassProductions.get(name)
            // in case of duplicate rules the cache will not be filled at this point.
            if (!isUndefined(cachedProduction)) {
                // filling up the _productions is always needed to inheriting grammars can access it (as an instance member)
                // otherwise they will be unaware of productions defined in super grammars.
                this._productions.put(name, cachedProduction)
            }
        }

        return this.defineRule(name, implementation, config)
    }

    /**
     * @See RULE
     * Same as RULE, but should only be used in "extending" grammars to override rules/productions
     * from the super grammar.
     */
    protected OVERRIDE_RULE<T>(name:string,
                               impl:(...implArgs:any[]) => T,
                               config:IRuleConfig<T> = DEFAULT_RULE_CONFIG):(idxInCallingRule?:number, ...args:any[]) => T {

        let ruleErrors = validateRuleName(name, this.className)
        ruleErrors = ruleErrors.concat(validateRuleIsOverridden(name, this.definedRulesNames, this.className))
        this.definitionErrors.push.apply(this.definitionErrors, ruleErrors) // mutability for the win

        let alreadyOverridden = cache.getProductionOverriddenForClass(this.className)

        // only build the GAST of an overridden rule once.
        if (!alreadyOverridden.containsKey(name)) {
            alreadyOverridden.put(name, true)
            let gastProduction = buildTopProduction(impl.toString(), name, this.tokensMap)
            this._productions.put(name, gastProduction)
        }
        else {
            let parserClassProductions = cache.getProductionsForClass(this.className)
            // filling up the _productions is always needed to inheriting grammars can access it (as an instance member)
            // otherwise they will be unaware of productions defined in super grammars.
            this._productions.put(name, parserClassProductions.get(name))
        }

        return this.defineRule(name, impl, config)
    }

    protected ruleInvocationStateUpdate(ruleName:string, idxInCallingRule:number):void {
        this.RULE_OCCURRENCE_STACK.push(idxInCallingRule)
        this.RULE_STACK.push(ruleName)
    }

    protected ruleFinallyStateUpdate():void {
        this.RULE_STACK.pop()
        this.RULE_OCCURRENCE_STACK.pop()

        if ((this.RULE_STACK.length === 0) && !this.isAtEndOfInput()) {
            let firstRedundantTok:Token = this.LA(1)
            this.SAVE_ERROR(new exceptions.NotAllInputParsedException(
                "Redundant input, expecting EOF but found: " + firstRedundantTok.image, firstRedundantTok))
        }
    }

    /**
     * Returns an "imaginary" Token to insert when Single Token Insertion is done
     * Override this if you require special behavior in your grammar.
     * For example if an IntegerToken is required provide one with the image '0' so it would be valid syntactically.
     */
    protected getTokenToInsert(tokClass:Function):Token {
        return new (<any>tokClass)(-1, -1)
    }

    /**
     * By default all tokens type may be inserted. This behavior may be overridden in inheriting Recognizers
     * for example: One may decide that only punctuation tokens may be inserted automatically as they have no additional
     * semantic value. (A mandatory semicolon has no additional semantic meaning, but an Integer may have additional meaning
     * depending on its int value and context (Inserting an integer 0 in cardinality: "[1..]" will cause semantic issues
     * as the max of the cardinality will be greater than the min value (and this is a false error!).
     */
    protected canTokenTypeBeInsertedInRecovery(tokClass:Function) {
        return true
    }

    /**
     * @param {Token} actualToken - The actual unexpected (mismatched) Token instance encountered.
     * @param {Function} expectedTokType - The Class of the expected Token.
     * @returns {string} - The error message saved as part of a MismatchedTokenException.
     */
    protected getMisMatchTokenErrorMessage(expectedTokType:Function, actualToken:Token):string {
        let hasLabel = hasTokenLabel(expectedTokType)
        let expectedMsg = hasLabel ?
            `--> ${tokenLabel(expectedTokType)} <--` :
            `token of type --> ${tokenName(expectedTokType)} <--`

        let msg = `Expecting ${expectedMsg} but found --> '${actualToken.image}' <--`

        return msg
    }

    protected getCurrentGrammarPath(tokClass:Function, tokIdxInRule:number):ITokenGrammarPath {
        let pathRuleStack:string[] = cloneArr(this.RULE_STACK)
        let pathOccurrenceStack:number[] = cloneArr(this.RULE_OCCURRENCE_STACK)
        let grammarPath:any = {
            ruleStack:         pathRuleStack,
            occurrenceStack:   pathOccurrenceStack,
            lastTok:           tokClass,
            lastTokOccurrence: tokIdxInRule
        }

        return grammarPath
    }

    // TODO: should this be a member method or a utility? it does not have any state or usage of 'this'...
    // TODO: should this be more explicitly part of the public API?
    protected getNextPossibleTokenTypes(grammarPath:ITokenGrammarPath) {
        let topRuleName = first(grammarPath.ruleStack)
        let gastProductions = this.getGAstProductions()
        let topProduction = gastProductions.get(topRuleName)
        let nextPossibleTokenTypes = new NextAfterTokenWalker(topProduction, grammarPath).startWalking()
        return nextPossibleTokenTypes
    }

    /**
     * @param tokClass - The Type of Token we wish to consume (Reference to its constructor function).
     * @param idx - Occurrence index of consumed token in the invoking parser rule text
     *         for example:
     *         IDENT (DOT IDENT)*
     *         the first ident will have idx 1 and the second one idx 2
     *         * note that for the second ident the idx is always 2 even if its invoked 30 times in the same rule
     *           the idx is about the position in grammar (source code) and has nothing to do with a specific invocation
     *           details.
     *
     * @returns {Token} - The consumed Token.
     */
    protected consumeInternal(tokClass:Function, idx:number):Token {
        try {
            return this.consumeInternalOptimized(tokClass)
        } catch (eFromConsumption) {
            // no recovery allowed during backtracking, otherwise backtracking may recover invalid syntax and accept it
            // but the original syntax could have been parsed successfully without any backtracking + recovery
            if (this.recoveryEnabled &&
                eFromConsumption instanceof exceptions.MismatchedTokenException && !this.isBackTracking()) {

                let follows = this.getFollowsForInRuleRecovery(tokClass, idx)
                try {
                    return this.tryInRuleRecovery(tokClass, follows)
                } catch (eFromInRuleRecovery) {
                    if (eFromInRuleRecovery.name === IN_RULE_RECOVERY_EXCEPTION) {
                        // failed in RuleRecovery.
                        // throw the original error in order to trigger reSync error recovery
                        throw eFromConsumption
                    }
                    else {
                        throw eFromInRuleRecovery
                    }
                }
            }
            else {
                throw eFromConsumption
            }
        }
    }

    /**
     * Convenience method equivalent to LA(1)
     * It is no longer used directly in chevrotain due to
     * performance considerations (avoid the need for inlining optimizations).
     *
     * But it is maintained for backward compatibility reasons.
     *
     * @deprecated
     */
    protected NEXT_TOKEN():Token {
        return this.LA(1)
    }

    // Lexer (accessing Token vector) related methods which can be overridden to implement lazy lexers
    // or lexers dependent on parser context.
    protected LA(howMuch:number):Token {
        if (this._input.length <= this.inputIdx + howMuch) {
            return new EOF()
        }
        else {
            return this._input[this.inputIdx + howMuch]
        }
    }

    protected consumeToken() {
        this.inputIdx++
    }

    protected savedTokenIdx:number

    protected saveLexerState() {
        this.savedTokenIdx = this.inputIdx
    }

    protected restoreLexerState() {
        this.inputIdx = this.savedTokenIdx
    }

    protected resetLexerState() {
        this.inputIdx = -1
    }

    // other functionality
    private saveRecogState():IParserState {
        let savedErrors = cloneArr(this.errors)
        let savedRuleStack = cloneArr(this.RULE_STACK)
        return {
            errors:     savedErrors,
            lexerState: this.inputIdx,
            RULE_STACK: savedRuleStack
        }
    }

    private reloadRecogState(newState:IParserState) {
        this.errors = newState.errors
        this.inputIdx = newState.lexerState
        this.RULE_STACK = newState.RULE_STACK
    }

    private defineRule<T>(ruleName:string,
                          impl:(...implArgs:any[]) => T,
                          config:IRuleConfig<T>):(idxInCallingRule?:number, ...args:any[]) => T {

        let resyncEnabled = has(config, "resyncEnabled") ?
            config.resyncEnabled :
            DEFAULT_RULE_CONFIG.resyncEnabled
        let recoveryValueFunc = has(config, "recoveryValueFunc") ?
            config.recoveryValueFunc :
            DEFAULT_RULE_CONFIG.recoveryValueFunc

        let wrappedGrammarRule = function (idxInCallingRule:number = 1, args:any[] = []) {
            this.ruleInvocationStateUpdate(ruleName, idxInCallingRule)

            try {
                // actual parsing happens here
                return impl.apply(this, args)
            } catch (e) {
                let isFirstInvokedRule = (this.RULE_STACK.length === 1)
                // note the reSync is always enabled for the first rule invocation, because we must always be able to
                // reSync with EOF and just output some INVALID ParseTree
                // during backtracking reSync recovery is disabled, otherwise we can't be certain the backtracking
                // path is really the most valid one
                let reSyncEnabled = isFirstInvokedRule || (
                    resyncEnabled
                    && !this.isBackTracking()
                    // if errorRecovery is disabled, the exception will be rethrown to the top rule
                    // (isFirstInvokedRule) and there will resync to EOF and terminate.
                    && this.recoveryEnabled)

                if (reSyncEnabled && exceptions.isRecognitionException(e)) {
                    let reSyncTokType = this.findReSyncTokenType()
                    if (this.isInCurrentRuleReSyncSet(reSyncTokType)) {
                        e.resyncedTokens = this.reSyncTo(reSyncTokType)
                        return recoveryValueFunc()
                    }
                    else {
                        // to be handled farther up the call stack
                        throw e
                    }
                }
                else {
                    // some other Error type which we don't know how to handle (for example a built in JavaScript Error)
                    throw e
                }
            }
            finally {
                this.ruleFinallyStateUpdate()
            }
        }
        let ruleNamePropName = "ruleName"
        wrappedGrammarRule[ruleNamePropName] = ruleName
        return wrappedGrammarRule
    }

    private tryInRepetitionRecovery(grammarRule:Function,
                                    grammarRuleArgs:any[],
                                    lookAheadFunc:() => boolean,
                                    expectedTokType:Function):void {
        // TODO: can the resyncTokenType be cached?
        let reSyncTokType = this.findReSyncTokenType()
        this.saveLexerState()
        let resyncedTokens = []
        let passedResyncPoint = false

        let nextTokenWithoutResync = this.LA(1)
        let currToken = this.LA(1)

        let generateErrorMessage = () => {
            // we are preemptively re-syncing before an error has been detected, therefor we must reproduce
            // the error that would have been thrown
            let msg = this.getMisMatchTokenErrorMessage(expectedTokType, nextTokenWithoutResync)
            let error = new exceptions.MismatchedTokenException(msg, nextTokenWithoutResync)
            // the first token here will be the original cause of the error, this is not part of the resyncedTokens property.
            error.resyncedTokens = dropRight(resyncedTokens)
            this.SAVE_ERROR(error)
        }

        while (!passedResyncPoint) {
            // re-synced to a point where we can safely exit the repetition/
            if (currToken instanceof expectedTokType) {
                generateErrorMessage()
                return // must return here to avoid reverting the inputIdx
            }
            // we skipped enough tokens so we can resync right back into another iteration of the repetition grammar rule
            else if (lookAheadFunc.call(this)) {
                generateErrorMessage()
                // recursive invocation in other to support multiple re-syncs in the same top level repetition grammar rule
                grammarRule.apply(this, grammarRuleArgs)
                return // must return here to avoid reverting the inputIdx
            }
            else if (currToken instanceof reSyncTokType) {
                passedResyncPoint = true
            }
            else {
                currToken = this.SKIP_TOKEN()
                this.addToResyncTokens(currToken, resyncedTokens)
            }
        }

        // we were unable to find a CLOSER point to resync inside the Repetition, reset the state.
        // The parsing exception we were trying to prevent will happen in the NEXT parsing step. it may be handled by
        // "between rules" resync recovery later in the flow.
        this.restoreLexerState()
    }

    private shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch?:Function, nextTokIdx?:number):boolean {
        // arguments to try and perform resync into the next iteration of the many are missing
        if (expectTokAfterLastMatch === undefined || nextTokIdx === undefined) {
            return false
        }

        // no need to recover, next token is what we expect...
        if (this.LA(1) instanceof expectTokAfterLastMatch) {
            return false
        }

        // error recovery is disabled during backtracking as it can make the parser ignore a valid grammar path
        // and prefer some backtracking path that includes recovered errors.
        if (this.isBackTracking()) {
            return false
        }

        // if we can perform inRule recovery (single token insertion or deletion) we always prefer that recovery algorithm
        // because if it works, it makes the least amount of changes to the input stream (greedy algorithm)
        //noinspection RedundantIfStatementJS
        if (this.canPerformInRuleRecovery(expectTokAfterLastMatch,
                this.getFollowsForInRuleRecovery(expectTokAfterLastMatch, nextTokIdx))) {
            return false
        }

        return true
    }

    // Error Recovery functionality
    private getFollowsForInRuleRecovery(tokClass:Function, tokIdxInRule:number):Function[] {
        let grammarPath = this.getCurrentGrammarPath(tokClass, tokIdxInRule)
        let follows = this.getNextPossibleTokenTypes(grammarPath)
        return follows
    }

    private tryInRuleRecovery(expectedTokType:Function, follows:Function[]):Token {
        if (this.canRecoverWithSingleTokenInsertion(expectedTokType, follows)) {
            let tokToInsert = this.getTokenToInsert(expectedTokType)
            tokToInsert.isInsertedInRecovery = true
            return tokToInsert

        }

        if (this.canRecoverWithSingleTokenDeletion(expectedTokType)) {
            let nextTok = this.SKIP_TOKEN()
            this.consumeToken()
            return nextTok
        }

        throw new InRuleRecoveryException("sad sad panda")
    }

    private canPerformInRuleRecovery(expectedToken:Function, follows:Function[]):boolean {
        return this.canRecoverWithSingleTokenInsertion(expectedToken, follows) ||
            this.canRecoverWithSingleTokenDeletion(expectedToken)
    }

    private canRecoverWithSingleTokenInsertion(expectedTokType:Function, follows:Function[]):boolean {
        if (!this.canTokenTypeBeInsertedInRecovery(expectedTokType)) {
            return false
        }

        // must know the possible following tokens to perform single token insertion
        if (isEmpty(follows)) {
            return false
        }

        let mismatchedTok = this.LA(1)
        let isMisMatchedTokInFollows = find(follows, (possibleFollowsTokType:Function) => {
                return mismatchedTok instanceof possibleFollowsTokType
            }) !== undefined

        return isMisMatchedTokInFollows
    }

    private canRecoverWithSingleTokenDeletion(expectedTokType:Function):boolean {
        let isNextTokenWhatIsExpected = this.LA(2) instanceof expectedTokType
        return isNextTokenWhatIsExpected
    }

    private isInCurrentRuleReSyncSet(token:Function):boolean {
        let followKey = this.getCurrFollowKey()
        let currentRuleReSyncSet = this.getFollowSetFromFollowKey(followKey)
        return contains(currentRuleReSyncSet, token)
    }

    private findReSyncTokenType():Function {
        let allPossibleReSyncTokTypes = this.flattenFollowSet()
        // this loop will always terminate as EOF is always in the follow stack and also always (virtually) in the input
        let nextToken = this.LA(1)
        let k = 2
        while (true) {
            let nextTokenType:any = (<any>nextToken).constructor
            if (contains(allPossibleReSyncTokTypes, nextTokenType)) {
                return nextTokenType
            }
            nextToken = this.LA(k)
            k++
        }
    }

    private getCurrFollowKey():IFollowKey {
        // the length is at least one as we always add the ruleName to the stack before invoking the rule.
        if (this.RULE_STACK.length === 1) {
            return EOF_FOLLOW_KEY
        }
        let currRuleIdx = this.RULE_STACK.length - 1
        let currRuleOccIdx = currRuleIdx
        let prevRuleIdx = currRuleIdx - 1

        return {
            ruleName:         this.RULE_STACK[currRuleIdx],
            idxInCallingRule: this.RULE_OCCURRENCE_STACK[currRuleOccIdx],
            inRule:           this.RULE_STACK[prevRuleIdx]
        }
    }

    private buildFullFollowKeyStack():IFollowKey[] {
        return map(this.RULE_STACK, (ruleName, idx) => {
            if (idx === 0) {
                return EOF_FOLLOW_KEY
            }
            return {
                ruleName:         ruleName,
                idxInCallingRule: this.RULE_OCCURRENCE_STACK[idx],
                inRule:           this.RULE_STACK[idx - 1]
            }
        })
    }

    private flattenFollowSet():Function[] {
        let followStack = map(this.buildFullFollowKeyStack(), (currKey) => {
            return this.getFollowSetFromFollowKey(currKey)
        })
        return <any>flatten(followStack)
    }

    private getFollowSetFromFollowKey(followKey:IFollowKey):Function[] {
        if (followKey === EOF_FOLLOW_KEY) {
            return [EOF]
        }

        let followName = followKey.ruleName + followKey.idxInCallingRule + IN + followKey.inRule
        return cache.getResyncFollowsForClass(this.className).get(followName)
    }

    // It does not make any sense to include a virtual EOF token in the list of resynced tokens
    // as EOF does not really exist and thus does not contain any useful information (line/column numbers)
    private addToResyncTokens(token:Token, resyncTokens:Token[]):Token[] {
        if (!(token instanceof EOF)) {
            resyncTokens.push(token)
        }
        return resyncTokens
    }

    private reSyncTo(tokClass:Function):Token[] {
        let resyncedTokens = []
        let nextTok = this.LA(1)
        while ((nextTok instanceof tokClass) === false) {
            nextTok = this.SKIP_TOKEN()
            this.addToResyncTokens(nextTok, resyncedTokens)
        }
        // the last token is not part of the error.
        return dropRight(resyncedTokens)
    }

    private attemptInRepetitionRecovery(prodFunc:Function,
                                        args:any[],
                                        lookaheadFunc:() => boolean,
                                        prodName:string,
                                        prodOccurrence:number,
                                        nextToksWalker:typeof AbstractNextTerminalAfterProductionWalker,
                                        prodKeys:HashTable<string>[]) {

        let key = this.getKeyForAutomaticLookahead(prodName, prodKeys, prodOccurrence)
        let firstAfterRepInfo = this.firstAfterRepMap.get(key)
        if (firstAfterRepInfo === undefined) {
            let currRuleName = last(this.RULE_STACK)
            let ruleGrammar = this.getGAstProductions().get(currRuleName)
            let walker:AbstractNextTerminalAfterProductionWalker = new nextToksWalker(ruleGrammar, prodOccurrence)
            firstAfterRepInfo = walker.startWalking()
            this.firstAfterRepMap.put(key, firstAfterRepInfo)
        }

        let expectTokAfterLastMatch = firstAfterRepInfo.token
        let nextTokIdx = firstAfterRepInfo.occurrence
        let isEndOfRule = firstAfterRepInfo.isEndOfRule

        // special edge case of a TOP most repetition after which the input should END.
        // this will force an attempt for inRule recovery in that scenario.
        if (this.RULE_STACK.length === 1 &&
            isEndOfRule &&
            expectTokAfterLastMatch === undefined) {
            expectTokAfterLastMatch = EOF
            nextTokIdx = 1
        }

        if (this.shouldInRepetitionRecoveryBeTried(expectTokAfterLastMatch, nextTokIdx)) {
            // TODO: performance optimization: instead of passing the original args here, we modify
            // the args param (or create a new one) and make sure the lookahead func is explicitly provided
            // to avoid searching the cache for it once more.
            this.tryInRepetitionRecovery(prodFunc, args, lookaheadFunc, expectTokAfterLastMatch)
        }
    }

    // Implementation of parsing DSL
    private optionInternal(predicateOrAction:Predicate | GrammarAction, action:GrammarAction, occurrence:number):boolean {
        let lookAheadFunc = this.getLookaheadFuncForOption(occurrence)
        if (action === undefined) {
            action = <any>predicateOrAction
        } // predicate present
        else if (!(predicateOrAction as Predicate).call(this)) {
            return false
        }

        if ((lookAheadFunc).call(this)) {
            action.call(this)
            return true
        }
        return false
    }

    private atLeastOneInternal(prodFunc:Function,
                               prodName:string,
                               prodOccurrence:number,
                               predicate:Predicate | GrammarAction,
                               action:GrammarAction | string,
                               userDefinedErrMsg?:string):void {
        let lookAheadFunc = this.getLookaheadFuncForAtLeastOne(prodOccurrence)
        if (!isFunction(action)) {
            userDefinedErrMsg = <any>action
            action = <any>predicate
        }
        // predicate present
        else {
            let orgLookAheadFunc = lookAheadFunc
            lookAheadFunc = () => {
                return (predicate as Predicate).call(this) &&
                    orgLookAheadFunc.call(this)
            }
        }

        if ((<Function>lookAheadFunc).call(this)) {
            (<any>action).call(this)
            while ((<Function>lookAheadFunc).call(this)) {
                (<any>action).call(this)
            }
        }
        else {
            throw this.raiseEarlyExitException(prodOccurrence, PROD_TYPE.REPETITION_MANDATORY, userDefinedErrMsg)
        }

        // note that while it may seem that this can cause an error because by using a recursive call to
        // AT_LEAST_ONE we change the grammar to AT_LEAST_TWO, AT_LEAST_THREE ... , the possible recursive call
        // from the tryInRepetitionRecovery(...) will only happen IFF there really are TWO/THREE/.... items.
        if (this.recoveryEnabled) {
            this.attemptInRepetitionRecovery(prodFunc, [lookAheadFunc, action, userDefinedErrMsg],
                <any>lookAheadFunc, prodName, prodOccurrence, NextTerminalAfterAtLeastOneWalker, this.atLeastOneLookaheadKeys)
        }
    }

    private atLeastOneSepFirstInternal(prodFunc:Function,
                                       prodName:string,
                                       prodOccurrence:number,
                                       separator:TokenConstructor,
                                       action:GrammarAction | string,
                                       userDefinedErrMsg?:string):Token[] {

        let separatorsResult = []
        let firstIterationLookaheadFunc = this.getLookaheadFuncForAtLeastOneSep(prodOccurrence)

        // 1st iteration
        if (firstIterationLookaheadFunc.call(this)) {
            (<GrammarAction>action).call(this)

            let separatorLookAheadFunc = () => {return this.LA(1) instanceof separator}
            // 2nd..nth iterations
            while (separatorLookAheadFunc()) {
                // note that this CONSUME will never enter recovery because
                // the separatorLookAheadFunc checks that the separator really does exist.
                separatorsResult.push(this.CONSUME(separator));
                (<GrammarAction>action).call(this)
            }

            if (this.recoveryEnabled) {
                this.attemptInRepetitionRecovery(this.repetitionSepSecondInternal,
                    [prodName, prodOccurrence, separator, separatorLookAheadFunc, action, separatorsResult,
                        this.atLeastOneSepLookaheadKeys, NextTerminalAfterAtLeastOneSepWalker],
                    separatorLookAheadFunc,
                    prodName,
                    prodOccurrence,
                    NextTerminalAfterAtLeastOneSepWalker,
                    this.atLeastOneSepLookaheadKeys)
            }
        }
        else {
            throw this.raiseEarlyExitException(prodOccurrence, PROD_TYPE.REPETITION_MANDATORY_WITH_SEPARATOR, userDefinedErrMsg)
        }

        return separatorsResult
    }

    private manyInternal(prodFunc:Function,
                         prodName:string,
                         prodOccurrence:number,
                         predicate:Predicate | GrammarAction,
                         action?:GrammarAction):void {

        let lookaheadFunction = this.getLookaheadFuncForMany(prodOccurrence)
        if (action === undefined) {
            action = <any>predicate
        }
        // predicate present
        else {
            let orgLookaheadFunction = lookaheadFunction
            lookaheadFunction = () => {
                return (predicate as Predicate).call(this) &&
                    orgLookaheadFunction.call(this)
            }
        }

        while (lookaheadFunction.call(this)) {
            action.call(this)
        }

        if (this.recoveryEnabled) {
            this.attemptInRepetitionRecovery(prodFunc,
                [lookaheadFunction, action],
                <any>lookaheadFunction
                , prodName,
                prodOccurrence,
                NextTerminalAfterManyWalker,
                this.manyLookaheadKeys)
        }
    }

    private manySepFirstInternal(prodFunc:Function,
                                 prodName:string,
                                 prodOccurrence:number,
                                 separator:TokenConstructor,
                                 action:GrammarAction):Token[] {

        let separatorsResult = []

        let firstIterationLaFunc = this.getLookaheadFuncForManySep(prodOccurrence)
        // 1st iteration
        if (firstIterationLaFunc.call(this)) {
            action.call(this)

            let separatorLookAheadFunc = () => {return this.LA(1) instanceof separator}
            // 2nd..nth iterations
            while (separatorLookAheadFunc()) {
                // note that this CONSUME will never enter recovery because
                // the separatorLookAheadFunc checks that the separator really does exist.
                separatorsResult.push(this.CONSUME(separator))
                action.call(this)
            }

            if (this.recoveryEnabled) {
                this.attemptInRepetitionRecovery(this.repetitionSepSecondInternal,
                    [prodName, prodOccurrence, separator, separatorLookAheadFunc, action, separatorsResult,
                        this.manySepLookaheadKeys, NextTerminalAfterManySepWalker],
                    separatorLookAheadFunc,
                    prodName,
                    prodOccurrence,
                    NextTerminalAfterManySepWalker,
                    this.manySepLookaheadKeys)
            }
        }

        return separatorsResult
    }

    private repetitionSepSecondInternal(prodName:string,
                                        prodOccurrence:number,
                                        separator:TokenConstructor,
                                        separatorLookAheadFunc:() => boolean,
                                        action:GrammarAction,
                                        separatorsResult:Token[],
                                        laKeys:HashTable<string>[],
                                        nextTerminalAfterWalker:typeof AbstractNextTerminalAfterProductionWalker):void {


        while (separatorLookAheadFunc()) {
            // note that this CONSUME will never enter recovery because
            // the separatorLookAheadFunc checks that the separator really does exist.
            separatorsResult.push(this.CONSUME(separator))
            action.call(this)
        }

        // we can only arrive to this function after an error
        // has occurred (hence the name 'second') so the following
        // IF will always be entered, its possible to remove it...
        // however it is kept to avoid confusion and be consistent.
        /* istanbul ignore else */
        if (this.recoveryEnabled) {
            this.attemptInRepetitionRecovery(this.repetitionSepSecondInternal,
                [prodName, prodOccurrence, separator, separatorLookAheadFunc,
                    action, separatorsResult, laKeys, nextTerminalAfterWalker],
                separatorLookAheadFunc,
                prodName,
                prodOccurrence,
                nextTerminalAfterWalker,
                laKeys)
        }
    }

    private orInternal<T>(alts:IAnyOrAlt<T>[],
                          errMsgTypes:string,
                          occurrence:number):T {
        // else implicit lookahead
        let laFunc = this.getLookaheadFuncForOr(occurrence, alts)
        let altToTake = laFunc.call(this, alts)
        if (altToTake !== -1) {
            let chosenAlternative:any = alts[altToTake]
            // TODO: should THEN_DO should be renamed to ALT to avoid this ternary  expression and to provide a consistent API.
            let grammarAction = chosenAlternative.ALT ?
                chosenAlternative.ALT :
                chosenAlternative.THEN_DO
            return grammarAction.call(this)
        }

        this.raiseNoAltException(occurrence, errMsgTypes)
    }

    // to enable optimizations this logic has been extract to a method as its invoker contains try/catch
    private consumeInternalOptimized(expectedTokClass:Function):Token {
        let nextToken = this.LA(1)
        if (nextToken instanceof expectedTokClass) {
            this.consumeToken()
            return nextToken
        }
        else {
            let msg = this.getMisMatchTokenErrorMessage(expectedTokClass, nextToken)
            throw this.SAVE_ERROR(new exceptions.MismatchedTokenException(msg, nextToken))
        }
    }

    private getKeyForAutomaticLookahead(prodName:string, prodKeys:HashTable<string>[], occurrence:number):string {
        let occuMap = prodKeys[occurrence - 1]
        let currRule = last(this.RULE_STACK)
        let key = occuMap[currRule]
        if (key === undefined) {
            key = prodName + occurrence + IN + currRule
            occuMap[currRule] = key
        }
        return key
    }

    private getLookaheadFuncForOr(occurrence:number, alts:IAnyOrAlt<any>[]):() => number {

        let key = this.getKeyForAutomaticLookahead("OR", this.orLookaheadKeys, occurrence)
        let laFunc = <any>this.classLAFuncs.get(key)
        if (laFunc === undefined) {
            let ruleName = last(this.RULE_STACK)
            let ruleGrammar = this.getGAstProductions().get(ruleName)
            // note that hasPredicates is only computed once.
            let hasPredicates = some(alts, (currAlt) => isFunction((<any>currAlt).WHEN))
            laFunc = buildLookaheadFuncForOr(occurrence, ruleGrammar, this.maxLookahead, hasPredicates)
            this.classLAFuncs.put(key, laFunc)
            return laFunc
        }
        else {
            return laFunc
        }
    }

    // Automatic lookahead calculation
    private getLookaheadFuncForOption(occurrence:number):() => boolean {
        let key = this.getKeyForAutomaticLookahead("OPTION", this.optionLookaheadKeys, occurrence)
        return this.getLookaheadFuncFor(key, occurrence, buildLookaheadForOption, this.maxLookahead)
    }

    private getLookaheadFuncForMany(occurrence:number):() => boolean {
        let key = this.getKeyForAutomaticLookahead("MANY", this.manyLookaheadKeys, occurrence)
        return this.getLookaheadFuncFor(key, occurrence, buildLookaheadForMany, this.maxLookahead)
    }

    private getLookaheadFuncForManySep(occurrence:number):() => boolean {
        let key = this.getKeyForAutomaticLookahead("MANY_SEP", this.manySepLookaheadKeys, occurrence)
        return this.getLookaheadFuncFor(key, occurrence, buildLookaheadForManySep, this.maxLookahead)
    }

    private getLookaheadFuncForAtLeastOne(occurrence:number):() => boolean {
        let key = this.getKeyForAutomaticLookahead("AT_LEAST_ONE", this.atLeastOneLookaheadKeys, occurrence)
        return this.getLookaheadFuncFor(key, occurrence, buildLookaheadForAtLeastOne, this.maxLookahead)
    }

    private getLookaheadFuncForAtLeastOneSep(occurrence:number):() => boolean {
        let key = this.getKeyForAutomaticLookahead("AT_LEAST_ONE_SEP", this.atLeastOneSepLookaheadKeys, occurrence)
        return this.getLookaheadFuncFor(key, occurrence, buildLookaheadForAtLeastOneSep, this.maxLookahead)
    }

    private getLookaheadFuncFor<T>(key:string,
                                   occurrence:number,
                                   laFuncBuilder:(number, rule, k) => () => T,
                                   maxLookahead:number):() => T {
        let laFunc = <any>this.classLAFuncs.get(key)
        if (laFunc === undefined) {
            let ruleName = last(this.RULE_STACK)
            let ruleGrammar = this.getGAstProductions().get(ruleName)
            laFunc = laFuncBuilder.apply(null, [occurrence, ruleGrammar, maxLookahead])
            this.classLAFuncs.put(key, laFunc)
            return laFunc
        }
        else {
            return laFunc
        }

    }

    // TODO: consider caching the error message computed information
    private raiseNoAltException(occurrence:number, errMsgTypes:string):void {
        let errSuffix = " but found: '" + this.LA(1).image + "'"
        if (errMsgTypes === undefined) {
            let ruleName = last(this.RULE_STACK)
            let ruleGrammar = this.getGAstProductions().get(ruleName)
            let lookAheadPathsPerAlternative = getLookaheadPathsForOr(occurrence, ruleGrammar, this.maxLookahead)
            let allLookAheadPaths = reduce(lookAheadPathsPerAlternative, (result, currAltPaths) => result.concat(currAltPaths), [])
            let nextValidTokenSequences = map(allLookAheadPaths, (currPath) =>
                `[${map(currPath, (currTokenClass) => tokenLabel(currTokenClass)).join(",")}]`)
            errMsgTypes = `one of these possible Token sequences:\n  <${nextValidTokenSequences.join(" ,")}>`
        }
        throw this.SAVE_ERROR(new exceptions.NoViableAltException(`Expecting: ${errMsgTypes} ${errSuffix}`, this.LA(1)))
    }

    // TODO: consider caching the error message computed information
    private raiseEarlyExitException(occurrence:number,
                                    prodType:PROD_TYPE,
                                    userDefinedErrMsg:string):void {
        let errSuffix = " but found: '" + this.LA(1).image + "'"
        if (userDefinedErrMsg === undefined) {
            let ruleName = last(this.RULE_STACK)
            let ruleGrammar = this.getGAstProductions().get(ruleName)
            let lookAheadPathsPerAlternative = getLookaheadPathsForOptionalProd(occurrence, ruleGrammar, prodType, this.maxLookahead)
            let insideProdPaths = lookAheadPathsPerAlternative[0]
            let nextValidTokenSequences = map(insideProdPaths, (currPath) =>
                `[${map(currPath, (currTokenClass) => tokenLabel(currTokenClass)).join(",")}]`)
            userDefinedErrMsg = `expecting at least one iteration which starts with one of these possible Token sequences::\n  ` +
                `<${nextValidTokenSequences.join(" ,")}>`
        }
        else {
            userDefinedErrMsg = `Expecting at least one ${userDefinedErrMsg}`
        }
        throw this.SAVE_ERROR(new exceptions.EarlyExitException(userDefinedErrMsg + errSuffix, this.LA(1)))
    }
}

function InRuleRecoveryException(message:string) {
    this.name = IN_RULE_RECOVERY_EXCEPTION
    this.message = message
}

InRuleRecoveryException.prototype = Error.prototype
