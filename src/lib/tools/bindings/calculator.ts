/**
 * Calculator binding — embeds mathjs (https://github.com/josdejong/mathjs,
 * Apache-2.0, by Jos de Jong) for deterministic arithmetic, unit-aware math
 * ("12.5 cm to inch"), percentages, and matrix/statistics expressions. LLMs
 * are unreliable at arithmetic; this hands the actual computation to a parser
 * built for safely evaluating untrusted expressions.
 *
 * Follows the mathjs security guidance: capture `evaluate`, then override the
 * capability-escalation functions so a hostile expression can't reach them
 * (https://mathjs.org/docs/expressions/security.html).
 */
import { all, create } from "mathjs";
import { ToolError } from "../manifest";

const MAX_EXPRESSION_LENGTH = 1_000;

const math = create(all);
const limitedEvaluate = math.evaluate.bind(math);

const disabled = (name: string) => () => {
  throw new Error(`Function ${name} is disabled`);
};
math.import(
  {
    import: disabled("import"),
    createUnit: disabled("createUnit"),
    reviver: disabled("reviver"),
    evaluate: disabled("evaluate"),
    parse: disabled("parse"),
    simplify: disabled("simplify"),
    derivative: disabled("derivative"),
    resolve: disabled("resolve"),
  },
  { override: true },
);

export interface CalculateResult {
  expression: string;
  /** The evaluated value, formatted with 14-digit precision. */
  result: string;
}

export function calculate(args: Record<string, unknown>): CalculateResult {
  const expression = typeof args.expression === "string" ? args.expression.trim() : "";
  if (!expression) throw new ToolError("Missing required argument: expression", 400);
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ToolError(`Expression too long (max ${MAX_EXPRESSION_LENGTH} chars)`, 400);
  }
  let value: unknown;
  try {
    value = limitedEvaluate(expression);
  } catch (e) {
    throw new ToolError(`Could not evaluate expression: ${e instanceof Error ? e.message : e}`, 400);
  }
  if (typeof value === "function") {
    throw new ToolError("Expression defines a function; provide arguments to evaluate it", 400);
  }
  return { expression, result: math.format(value, { precision: 14 }) };
}
