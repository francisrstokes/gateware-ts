/**
 * @internal
 * @packageDocumentation
 */
import { ExpressionEvaluator } from './expression-evaluation';
import { GWModule } from "../gw-module";
import { AssignmentStatement, CombinationalLogic, UnsliceableExpressionMap } from '../main-types';
import { ASSIGNMENT_EXPRESSION, COMBINATIONAL_SWITCH_ASSIGNMENT_STATEMENT } from '../constants';
import { TabLevel } from '../helpers';
import { CombinationalSwitchAssignmentStatement, Port, CombinationalSignalType } from './../main-types';

export class CombLogicEvaluator {
  private workingModule: GWModule;
  private expr: ExpressionEvaluator;
  private t: TabLevel;
  private drivenSignals:Port[] = [];
  private signalTypes:Map<Port, CombinationalSignalType> = new Map();

  getDrivenSignals() { return this.drivenSignals; }
  getSignalTypes() { return this.signalTypes; }

  constructor(m:GWModule, uem:UnsliceableExpressionMap, indentLevel:number = 1) {
    this.t = new TabLevel('  ', indentLevel);
    this.workingModule = m;
    this.expr = new ExpressionEvaluator(m, uem);
    this.evaluate = this.evaluate.bind(this);
  }

  private addDrivenSignal(driven:Port) {
    if (!this.drivenSignals.includes(driven)) {
      this.drivenSignals.push(driven);
    }
  }

  private assignSignalType(s:Port, type:CombinationalSignalType) {
    const signalType = this.signalTypes.get(s);
    if (typeof signalType === 'undefined') {
      this.signalTypes.set(s, type);
    } else {
      if (signalType !== type) {
        const moduleName = this.workingModule.moduleName;
        const signalName = this.workingModule.getModuleSignalDescriptor(s).name;
        throw new Error(`Combinational Drive Type Error: Cannot drive ${moduleName}.${signalName} as both a register and a wire.`);
      }
    }
  }

  setWorkingModule(m:GWModule) {
    this.workingModule = m;
    this.expr.setWorkingModule(m);
  }

  evaluate(expr:CombinationalLogic) {
    switch (expr.type) {
      case ASSIGNMENT_EXPRESSION: {
        return this.evaluateAssignmentExpression(expr as AssignmentStatement);
      }

      case COMBINATIONAL_SWITCH_ASSIGNMENT_STATEMENT: {
        return this.evaluateSwitchAssignmentExpression(expr as CombinationalSwitchAssignmentStatement);
      }
    }
  }

  evaluateAssignmentExpression(expr:AssignmentStatement) {
    const assigningRegister = this.workingModule.getModuleSignalDescriptor(expr.a);

    if (assigningRegister.type === 'input') {
      throw new Error('Cannot assign to an input in combinational logic.');
    }

    this.addDrivenSignal(expr.a);
    this.assignSignalType(expr.a, CombinationalSignalType.Wire);

    return `${this.t.l()}assign ${assigningRegister.name} = ${this.expr.evaluate(expr.b)};`;
  }

  evaluateSwitchAssignmentExpression(expr:CombinationalSwitchAssignmentStatement) {
    const assigningRegister = this.workingModule.getModuleSignalDescriptor(expr.to);
    if (assigningRegister.type === 'input') {
      throw new Error('Cannot assign to an input in combinational logic.');
    }
    this.addDrivenSignal(expr.to);
    this.assignSignalType(expr.to, CombinationalSignalType.Register);

    const out = [];

    // The outer code will wrap this in an always @(*) block
    this.t.push();
    out.push(`${this.t.l()}case (${this.expr.evaluate(expr.conditionalSignal)})`);
    this.t.push();

    expr.cases.forEach(([testCase, outputSignal]) => {
      out.push(`${this.t.l()}${this.expr.evaluate(testCase)} : begin`);
      out.push(`${this.t.l(1)}${this.expr.evaluate(expr.to)} = ${this.expr.evaluate(outputSignal)};`);
      out.push(`${this.t.l()}end`);
    });

    out.push(`${this.t.l()}default : begin`);
    out.push(`${this.t.l(1)}${this.expr.evaluate(expr.to)} = ${this.expr.evaluate(expr.defaultCase)};`);
    out.push(`${this.t.l()}end`);

    this.t.pop();
    out.push(`${this.t.l()}endcase`);
    this.t.pop();

    return out.join('\n');
  }
};
