import { ExpressionEvaluator } from './expression-evaluation';
import { GWModule } from "../gw-module";
import {
  SimulationExpression,
  AssignmentExpression,
  SwitchExpression,
  SubjectiveCaseExpression,
  SyncBlock,
  Edge,
  EdgeAssertion,
  RepeatedEdgeAssertion,
  DisplayExpression,
} from '../main-types';
import {
  ASSIGNMENT_EXPRESSION,
  IF_EXPRESSION,
  CASE_EXPRESSION,
  EDGE_ASSERTION,
  REPEATED_EDGE_ASSERTION,
  DISPLAY_EXPRESSION,
  FINISH_EXPRESSION,
  ELSE_IF_EXPRESSION,
  ELSE_EXPRESSION,
} from '../constants';
import { IfStatement, IfElseBlock, ElseIfStatement } from '../block-expressions';
import { TabLevel } from '../helpers';
import { getRegSize } from './common';
import { SignalT } from '../signals';

const edgeToString = (e:Edge) => {
  if (e === Edge.Positive) {
    return 'posedge';
  } else if (e === Edge.Negative) {
    return 'negedge';
  }
  throw new Error('Unknown edge type.');
}

export class SimulationEvaluator {
  private workingModule: GWModule;
  private expr: ExpressionEvaluator;
  private t: TabLevel;

  constructor(m:GWModule, indentLevel:number = 1) {
    this.t = new TabLevel('  ', indentLevel);

    this.workingModule = m;
    this.expr = new ExpressionEvaluator(m);
    this.evaluate = this.evaluate.bind(this);
  }

  getVcdBlock() {
    const vcdPath = this.workingModule.simulation.getVcdOutputPath();
    if (!vcdPath) return '';

    const out = [];
    out.push(`${this.t.l()}initial begin`)
    this.t.push();
    out.push(`${this.t.l()}$dumpfile("${vcdPath}");`);
    out.push(`${this.t.l()}$dumpvars(0);`);
    this.t.pop();
    out.push(`${this.t.l()}end`);

    return out.join('\n');
  }

  getRunBlock() {
    const out = [];
    out.push(`${this.t.l()}initial begin`);
    this.t.push();

    this.workingModule.simulation.getRunBody().forEach(expr => {
      out.push(this.evaluate(expr));
    });

    out.push(`${this.t.l()}$finish;`);
    this.t.pop();
    out.push(`${this.t.l()}end`);

    return out.join('\n');
  }

  getRegisterBlock() {
    const out = [];
    [...this.workingModule.getSignalMap().input.entries()].forEach(([port, name]) => {
      out.push(`${this.t.l()}reg ${getRegSize(port)}${name} = ${this.expr.evaluate((port as SignalT).defaultValue)};`);
    });
    return out.join('\n');
  }

  getWireBlock() {
    const out = [];
    [...this.workingModule.getSignalMap().output.entries()].forEach(([port, name]) => {
      out.push(`${this.t.l()}wire ${getRegSize(port)}${name};`);
    });
    return out.join('\n');
  }

  getSubmodules() {
    const out = [];
    const args = [];
    this.workingModule.getSubmodules().forEach(smRef => {
      out.push(`${this.t.l()}${smRef.m.moduleName} ${smRef.submoduleName} (`);
      this.t.push();

      Object.entries(smRef.mapping.inputs).forEach(([name, port]) => {
        const connectingSignalName = this.workingModule.getModuleSignalDescriptor(port).name;
        args.push(`${this.t.l()}.${name}(${connectingSignalName})`);
      });

      Object.entries(smRef.mapping.outputs).forEach(([name, ports]) => {
        if (ports.length === 0) {
          return;
        }

        if (ports.length > 1) {
          // TODO: Perhaps revisit this in the future
          throw new Error(`Ports cannot output to multiple signals in simulation (${name})`);
        }
        const connectingSignalName = this.workingModule.getModuleSignalDescriptor(ports[0]).name;
        args.push(`${this.t.l()}.${name}(${connectingSignalName})`);
      });

      out.push(args.join(',\n'));
      this.t.pop();
      out.push(`${this.t.l()});`);
    });
    return out.join('\n');
  }

  getEveryTimescaleBlocks() {
    return this.workingModule.simulation.getEveryTimescaleBlocks().map(([time, block]) => {
      const out = [];
      out.push(`${this.t.l()}always #${time} begin`);
      this.t.push();

      block.forEach(expr => {
        out.push(`${this.evaluate(expr)}`);
      });

      this.t.pop();
      out.push(`${this.t.l()}end`);
      return out.join('\n');
    }).join('\n');
  }

  setWorkingModule(m:GWModule) {
    this.workingModule = m;
    this.expr.setWorkingModule(m);
  }

  evaluate(expr:SimulationExpression) {
    switch (expr.type) {
      case ASSIGNMENT_EXPRESSION: {
        return this.evaluateAssignmentExpression(expr as AssignmentExpression);
      }

      case IF_EXPRESSION: {
        return this.evaluateIfExpression(expr);
      }

      case ELSE_IF_EXPRESSION: {
        return this.evaluateElseIfExpression(expr);
      }

      case ELSE_EXPRESSION: {
        return this.evaluateElseExpression(expr);
      }

      case EDGE_ASSERTION: {
        return this.evaluateEdgeAssertion(expr as EdgeAssertion);
      }

      case REPEATED_EDGE_ASSERTION: {
        return this.evaluateRepeatedEdgeAssertion(expr as RepeatedEdgeAssertion);
      }

      case DISPLAY_EXPRESSION: {
        return this.evaluateDisplayExpression(expr as DisplayExpression);
      }

      case FINISH_EXPRESSION: {
        return `${this.t.l()}$finish();`;
      }
    }
  }

  evaluateEdgeAssertion(e:EdgeAssertion) {
    return `${this.t.l()}@(${edgeToString(e.edgeType)} ${this.expr.evaluate(e.signal)});`;
  }

  evaluateRepeatedEdgeAssertion(e:RepeatedEdgeAssertion) {
    return `${this.t.l()}repeat(${e.n}) @(${edgeToString(e.edgeType)} ${this.expr.evaluate(e.signal)});`;
  }

  evaluateDisplayExpression(d:DisplayExpression) {
    const params = d.messages.map(message => {
      if (typeof message === 'string') {
        return `"${message}"`;
      }
      return this.workingModule.getModuleSignalDescriptor(message).name
    }).join(', ');
    return `${this.t.l()}$display(${params});`;
  }

  evaluateBlock(s:SyncBlock) {
    const sensitivitySignalName = this.workingModule.getModuleSignalDescriptor(s.signal).name;
    let out = [
      `${this.t.l()}always @(${s.edge === Edge.Positive ? 'posedge' : 'negedge' } ${sensitivitySignalName}) begin`,
    ];

    this.t.push();
    s.block.forEach(expr => out.push(this.evaluate(expr)));
    this.t.pop();
    out.push(`${this.t.l()}end`);

    return out.join('\n');
  }

  evaluateAssignmentExpression(aExpr:AssignmentExpression) {
    let assigningRegister = this.workingModule.getModuleSignalDescriptor(aExpr.a);
    return `${this.t.l()}${assigningRegister.name} = ${this.expr.evaluate(aExpr.b)};`;
  }

  evaluateIfExpression(iExpr:IfStatement<SimulationExpression>) {
    const out = [];

    out.push(`${this.t.l()}if (${this.expr.evaluate(iExpr.subject)}) begin`);

    this.t.push();
    iExpr.exprs.forEach(expr => out.push(this.evaluate(expr)));
    this.t.pop();

    out.push(`${this.t.l()}end`);
    return out.join('\n');
  }

  evaluateElseIfExpression(iExpr:ElseIfStatement<SimulationExpression>) {
    const out = [];

    const parentIf = iExpr.parentStatement.type === IF_EXPRESSION
      ? this.evaluateIfExpression(iExpr.parentStatement)
      : this.evaluateElseIfExpression(iExpr.parentStatement);

    const elseIf = `${this.t.l()}else if (${this.expr.evaluate(iExpr.elseSubject)}) begin`;
    const endElse = `${this.t.l()}end`;

    out.push(parentIf, elseIf);

    this.t.push();
    iExpr.elseExprs.forEach(expr => out.push(this.evaluate(expr)));
    this.t.pop();

    out.push(endElse);

    return out.join('\n');
  }

  evaluateElseExpression(iExpr:IfElseBlock<SimulationExpression>) {
    const out = [];

    const parentIf = iExpr.parent.type === IF_EXPRESSION
      ? this.evaluateIfExpression(iExpr.parent)
      : this.evaluateElseIfExpression(iExpr.parent);

    const elseStart = `${this.t.l()}else begin`;
    const endElse = `${this.t.l()}end`;

    out.push(parentIf, elseStart);

    this.t.push();
    iExpr.elseClause.forEach(expr => out.push(this.evaluate(expr)));
    this.t.pop();

    out.push(endElse);

    return out.join('\n');
  }

  evaluateSwitchExpression(sExpr:SwitchExpression) {
    const out = [];
    out.push(`${this.t.l()}case (${this.expr.evaluate(sExpr.subject)})`);
    this.t.push();

    out.push(
      sExpr.cases.map(expr => {
        const caseOut = [];

        if (expr.type === CASE_EXPRESSION) {
          const caseExpr = expr as SubjectiveCaseExpression;
          caseOut.push(`${this.t.l()}${this.expr.evaluate(caseExpr.subject)} : begin`);
        } else {
          caseOut.push(`${this.t.l()}default : begin`);
        }
        this.t.push();

        caseOut.push(
          expr.body.map(bodyExpr => this.evaluate(bodyExpr)).join('\n')
        );

        this.t.pop();
        caseOut.push(`${this.t.l()}end`);

        return caseOut.join('\n');
      }).join('\n\n')
    );

    this.t.pop();
    out.push(`${this.t.l()}endcase`);
    return out.join('\n');
  }
}