"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;
var _antlr = _interopRequireDefault(require("antlr4"));
var _AtomTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/AtomTransition.js"));
var _RuleTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/RuleTransition"));
var _SetTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/SetTransition.js"));
var _RuleStopState = _interopRequireDefault(require("antlr4/src/antlr4/state/RuleStopState.js"));
var _NotSetTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/NotSetTransition.js"));
var _PrecedencePredicateTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/PrecedencePredicateTransition"));
var _intervalSet = require("./utils/intervalSet");
var _WildcardTransition = _interopRequireDefault(require("antlr4/src/antlr4/transition/WildcardTransition.js"));
var _LexerActionFinder = _interopRequireDefault(require("./utils/LexerActionFinder"));
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
const DEBUG = 0;
const caret = new _antlr.default.CommonToken();
const STOP = Symbol("Stop");
const DEFAULT_INITIAL_RULE = 0;
const DEFAULT_OPTS = {
  // This won't be a problem for 99.9999% of grammars and it adds a slight impact in performance
  ignoreSuggestionsInNonDefaultChannels: false,
  initialRule: DEFAULT_INITIAL_RULE,
  suggestRules: new Set(),
  recovery: []
};
class DebugStats {
  constructor() {
    this._recoveries = {};
  }
  recovery(rule) {
    const id = `${rule.ifInRule}-${rule.andFindToken}-${rule.thenGoToRule}`;
    let val = this._recoveries[id];
    if (!val) {
      val = {
        rule,
        attempts: 0
      };
      this._recoveries[id] = val;
    }
    val.attempts += 1;
  }
  toString() {
    return JSON.stringify(this._recoveries);
  }
}
class Suggestion {
  constructor(id, ctxt, isRule = false) {
    this.id = id; //Id of the token or rule 
    this.ctxt = [ctxt];
    this.isRule = isRule;
  }

  // Slightly weird methods for more friendly access names. Maybe I should have done inheritance
  get token() {
    return this.isRule ? null : this.id;
  }
  get rule() {
    return this.isRule ? this.id : null;
  }
}
function groupSuggestions(suggestions) {
  const tSuggestionByName = {};
  const rSuggestionByName = {};
  const grouped = [];
  for (const s of suggestions) {
    let register = false ? rSuggestionByName : tSuggestionByName;
    if (register[s.token]) register[s.token].ctxt = register[s.token].ctxt.concat(s.ctxt);else {
      grouped.push(s);
      register[s.token] = s;
    }
  }
  return grouped;
}
class ThrowErrorListener extends _antlr.default.error.ErrorListener {
  syntaxError(recognizer, offendingSymbol, line, column, msg, e) {
    throw new Error("line " + line + ":" + column + " " + msg);
  }
}
class Autocompleter {
  constructor(Lexer, Parser, options = DEFAULT_OPTS) {
    this._lexer = Lexer;
    this._parser = Parser;
    this._atn = null;
    this.options = options ? options : DEFAULT_OPTS;
  }
  get atn() {
    return this._atn;
  }
  get parserRuleNames() {
    return this._parser.ruleNames;
  }
  autocomplete(input) {
    const chars = new _antlr.default.CharStreams.fromString(input);
    const lexer = new this._lexer(chars);
    lexer.removeErrorListeners();
    lexer.addErrorListener(new ThrowErrorListener());
    const all = lexer.getAllTokens();
    const tokenList = all.filter(x => x.channel === 0);
    tokenList.push(caret);
    const parser = new this._parser(lexer);
    this._atn = parser.atn;
    const startingRule = this.options?.initialRule ?? DEFAULT_INITIAL_RULE;
    const initialState = parser.atn.ruleToStartState[startingRule];
    if (initialState === undefined) throw new Error("Unexpected starting rule: " + startingRule);
    const stack = [[0, initialState, [], [[startingRule, STOP, 0]]]];
    this._debugStats = new DebugStats();
    this.options.debugStats = this._debugStats;
    if (!this.options.suggestRules) this.options.suggestRules = new Set();
    this.options.__cache = {};
    for (const rule of parser.atn.ruleToStartState) {
      this.options.__cache[rule.ruleIndex] = this._executeATN([caret], [[0, parser.atn.ruleToStartState[rule.ruleIndex], [], [[rule.ruleIndex, STOP, 0]]]],
      // To keep the parserStack of the suggestions consistent, the cache stores Suggestions, not just the token
      {
        ...this.options,
        recovery: [],
        __cache: null,
        suggestRules: new Set()
      }, parser.atn);
    }
    const suggestions = this._executeATN(tokenList, stack, this.options);
    const grouped = groupSuggestions(suggestions);
    return this.options?.ignoreSuggestionsInNonDefaultChannels ? this._filterNonDefaultChannels(grouped, lexer) : grouped;
  }
  log(msg, stack) {
    if (DEBUG) console.log(`${" ".repeat(stack.length * 2)} - ${msg}`);
  }
  _executeATN(tokens, stack, options) {
    const suggestions = [];
    while (stack.length !== 0) {
      let [tokenStreamIndex, state, alreadyPassed, parserStack, recoveryData] = stack.pop();
      this.log(`[${state.stateNumber}] Next token: ${tokens[tokenStreamIndex]}. Already passed: ${alreadyPassed}`, stack);
      let limitNextState = null;
      if (recoveryData !== undefined) {
        // If the number doesn't match, it means the rule hasn't failed
        if (suggestions.length !== recoveryData.suggestions) continue;
        let rule = recoveryData.recoveryRules[0];
        this._onFail(stack, tokens, parserStack, tokenStreamIndex, rule, options, state);
        // If it has nSuggestions it means it's a rule that has already been traversed and therefore
        // we shouldn't traverse it again
        continue;
      }

      // In theory it should never be 0
      if (state instanceof _RuleStopState.default && parserStack.length !== 0) {
        const [lastRule, nextState] = parserStack[parserStack.length - 1];
        this.log(`[${state.stateNumber}] - Finished rule ${this.parserRuleNames[state.ruleIndex]} going to state ${nextState.toString()}`, stack);
        if (!state.ruleIndex === lastRule) throw new Error("Unexpected situation. Exited a rule that isn't the last one that was entered");
        limitNextState = nextState;
        // It's important to make a shallow copy to avoid affecting the other alternatives.
        parserStack = parserStack.slice(0, -1);
      }

      // Iterates through the transitions in reverse order so that the first transition is processed first (therefore it's pushed the last)
      // This way if the grammar says '(A|B|C)', the autocompleter will suggest them in that same order
      for (let i = state.transitions.length - 1; i >= 0; i--) {
        const it = state.transitions[i];
        if (it.isEpsilon && !alreadyPassed.includes(it.target.stateNumber)) {
          if (it instanceof _PrecedencePredicateTransition.default && it.precedence < parserStack[parserStack.length - 1][2]) continue;
          const nextToken = tokens[tokenStreamIndex];
          if (it instanceof _RuleTransition.default) {
            if (nextToken === caret) {
              if (options.suggestRules.has(it.ruleIndex)) {
                suggestions.push(new Suggestion(it.ruleIndex, parserStack.map(y => y[0]), true));
                continue;
              } else if (options.__cache) {
                options.__cache[it.target.ruleIndex]?.forEach(s => suggestions.push(new Suggestion(s.token, [...parserStack.map(x => x[0]), ...s.ctxt[0]])));
                continue;
              }
              // If there is no cache then it must keep going and enter the rule to find the suggestions
            } else if (options.__cache && !options.__cache[it.target.ruleIndex].map(s => s.token).includes(nextToken.type))
              // This means that the next token doesn't match any of the first possible tokens of the rule. So we ignore this 
              // transition since it's going to fail either way. Plus entering the rule could end up triggering an unnecessary
              // recovery (since the failure is guaranteed)
              continue;
          }
          const newParserStack = it instanceof _RuleTransition.default ? [...parserStack, [it.ruleIndex, it.followState, it.precedence]] : parserStack;
          this.log(`[${state.stateNumber}] ${it instanceof _RuleTransition.default ? `Entering rule ${it.ruleIndex}` : `Epsilon transition to ${it.target}`}`, stack);
          // Doesn't increase 'tokenStreamIndex' because it doesn't consume tokens
          if (limitNextState && it.target !== limitNextState) continue;
          let recoveryRules = options?.recovery ? options.recovery.filter(x => x.ifInRule === it.ruleIndex) : [];
          if (it instanceof _RuleTransition.default && recoveryRules.length > 0) {
            // We are going to enter a rule that has a recovery rule.
            // Repush the current state but adding the number of suggestions and then add 
            // the next state
            stack.push([tokenStreamIndex, state, alreadyPassed, parserStack, {
              suggestions: suggestions.length,
              recoveryRules
            }]);
          }
          stack.push([tokenStreamIndex, it.target, it instanceof _RuleTransition.default || state instanceof _RuleStopState.default ? [] : [it.target.stateNumber, ...alreadyPassed], newParserStack]);
          // This has to go before SetTransition because NoSetTransition is a subclass of SetTransition
        } else if (it instanceof _NotSetTransition.default) {
          const nextToken = tokens[tokenStreamIndex];
          if (nextToken === caret) {
            suggestions.push(...(0, _intervalSet.intervalToArray)(_intervalSet.complement.bind(it.label)(_antlr.default.Token.MIN_USER_TOKEN_TYPE, this.atn.maxTokenType)).map(x => new Suggestion(x, parserStack.map(y => y[0])), parserStack));
          } else if (!it.label.contains(nextToken.type)) {
            stack.push([tokenStreamIndex + 1,
            // Increase the index because it has consumed a token
            it.target, [],
            // It resets 'alreadyPassed' because it just consumed a token, so it's not longer at risk of getting stuck in an infinite loop. 
            parserStack]);
          }
        } else if (it instanceof _AtomTransition.default || it instanceof _SetTransition.default) {
          const nextToken = tokens[tokenStreamIndex];
          if (nextToken === caret) {
            this.log(`[${state.stateNumber}] In caret. Added suggestions: ${(0, _intervalSet.intervalToArray)(it.label, parserStack.map(x => x[0])).map(x => x.token)}`, stack);
            suggestions.push(...(0, _intervalSet.intervalToArray)(it.label).map(x => new Suggestion(x, parserStack.map(y => y[0])), parserStack));
          } else if (it.label.contains(nextToken.type)) {
            stack.push([tokenStreamIndex + 1,
            // Increase the index because it has consumed a token
            it.target, [],
            // It resets 'alreadyPassed' because it just consumed a token, so it's not longer at risk of getting stuck in an infinite loop. 
            parserStack]);
          } else this.log(`[${state.stateNumber}]Dead end. Expecting ${it.label} but found ${nextToken.type}`, stack);
        } else if (it instanceof _WildcardTransition.default) {
          const nextToken = tokens[tokenStreamIndex];
          if (nextToken === caret) {
            suggestions.push(...(0, _intervalSet.intervalToArray)({
              intervals: [{
                start: _antlr.default.Token.MIN_USER_TOKEN_TYPE,
                stop: this.atn.maxTokenType + 1
              }]
            }).map(x => new Suggestion(x, parserStack.map(y => y[0])), parserStack));
          } else {
            stack.push([tokenStreamIndex + 1,
            // Increase the index because it has consumed a token
            it.target, [],
            // It resets 'alreadyPassed' because it just consumed a token, so it's not longer at risk of getting stuck in an infinite loop. 
            parserStack]);
          }
        } else if (alreadyPassed.includes(it.target.stateNumber)) this.log("Dead end. Epsilon transition already passed");else this.log("Dead end - Unknown transition", stack);
      }
    }
    return suggestions;
  }

  /*
  * The problem with filtering non default channels is that neither the lexer nor the ATN leave an easy record of what is the
  * channel of a token. To access it this ends up searching for the lexe rule for that token in the lexer ATN and then looks 
  * for an action state
  */
  _filterNonDefaultChannels(suggestions, lexer) {
    return suggestions.filter(x => {
      let rule;
      for (const [i, tokenType] of lexer.atn.ruleToTokenType.entries()) {
        if (x.token === tokenType) {
          rule = i;
          break;
        }
      }
      // This shouldn't happen but just in case return true
      if (rule === undefined) return true;
      const actions = (0, _LexerActionFinder.default)(lexer.atn.ruleToStartState[rule]);
      return !actions.some(x => {
        const channel = lexer.atn.lexerActions[x].channel;
        return channel !== undefined && channel !== _antlr.default.Token.DEFAULT_CHANNEL;
      });
    });
  }

  // CurrentState should always be a state with a transition that is a RuleTransition. Since this is called
  // from the state before actually entering the rule?
  _onFail(stack, tokens, parserStack, tokenStreamIndex, rule, options, currentState) {
    const {
      andFindToken,
      thenGoToRule,
      skipOne,
      thenFinishRule
    } = rule;
    // tokenStreamIndex + 1 to avoid it from recovering in the same token, which
    // would be confusing . If you have let = = let a = b the rule starts in the 
    // first 'let' so it wouldn't make any sense to try to recover by entering the 
    // same rule again
    for (let i = tokenStreamIndex + 1; i < tokens.length; i++) {
      if (tokens[i].type === andFindToken) {
        options.debugStats.recovery(rule);
        //recoverCounter += 1;
        if (thenGoToRule) {
          stack.push([skipOne ? i + 1 : i, this.atn.ruleToStartState[thenGoToRule], [],
          // We add the current rule to the parser stack as if it had been entered through a RuleStartTransition //TODO wait we are not doing this here wtf
          parserStack]);
        } else if (thenFinishRule) {
          stack.push([skipOne ? i + 1 : i, currentState.transitions[0].followState, [], parserStack /*.slice(0,-1)*/]);
        }

        return;
      }
    }
  }
}
var _default = Autocompleter;
exports.default = _default;