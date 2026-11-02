export type RuleField = "username" | "bio" | "message";
export interface RegexCondition {
  field: RuleField;
  pattern: string;
  flags: string;
}
export interface RegexRule {
  id: string;
  name: string;
  enabled: boolean;
  action: "allow" | "ban";
  conditions: RegexCondition[];
}
export function validateRules(value: unknown): RegexRule[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error("最多配置32条规则或规则组");
  }
  const seen = new Set<string>();
  return value.map((rule, index) => {
    if (
      !rule || typeof rule !== "object" || Object.keys(rule).some((k) =>
        !["id", "name", "enabled", "action", "conditions"].includes(k)
      ) || typeof rule.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(rule.id) || seen.has(rule.id) ||
      typeof rule.name !== "string" || rule.name.length > 64 ||
      typeof rule.enabled !== "boolean" ||
      !["allow", "ban"].includes(rule.action) ||
      !Array.isArray(rule.conditions) || rule.conditions.length < 1 ||
      rule.conditions.length > 8
    ) {
      throw new Error(`第${index + 1}条规则格式无效；每组需1至8个条件`);
    }
    seen.add(rule.id);
    const conditions = rule.conditions.map((condition: RegexCondition) => {
      if (
        !condition || typeof condition !== "object" ||
        Object.keys(condition).some((k) =>
          !["field", "pattern", "flags"].includes(k)
        ) || !["username", "bio", "message"].includes(condition.field) ||
        typeof condition.pattern !== "string" || !condition.pattern ||
        condition.pattern.length > 256 || typeof condition.flags !== "string" ||
        !/^[imsu]*$/.test(condition.flags) ||
        new Set(condition.flags).size !== condition.flags.length
      ) {
        throw new Error(
          `第${index + 1}条规则条件无效，正则最长256字，仅支持 i/m/s/u 标志`,
        );
      }
      try {
        new RegExp(condition.pattern, condition.flags);
      } catch {
        throw new Error(`第${index + 1}条规则的正则语法无效`);
      }
      return {
        field: condition.field,
        pattern: condition.pattern,
        flags: condition.flags,
      };
    });
    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      action: rule.action,
      conditions,
    };
  });
}
const workerSource = `self.onmessage = ({data}) => {
  try {
    for (const rule of data.rules) {
      if (rule.enabled && rule.conditions.every(c => typeof data.fields[c.field] === 'string' && new RegExp(c.pattern,c.flags).test(data.fields[c.field]))) {
        self.postMessage({rule}); return;
      }
    }
    self.postMessage({});
  } catch { self.postMessage({failed:true}); }
};`;
export async function matchRules(
  rules: RegexRule[],
  fields: Partial<Record<RuleField, string>>,
  timeoutMs = 150,
): Promise<{ rule?: RegexRule; failed?: boolean }> {
  if (!rules.some((r) => r.enabled)) return {};
  // Isolate matching so a backtracking expression cannot block bot updates or HTTP.
  const worker = new Worker(
    "data:application/javascript," + encodeURIComponent(workerSource),
    { type: "module" },
  );
  return await new Promise((resolve) => {
    const finish = (value: { rule?: RegexRule; failed?: boolean }) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ failed: true }), timeoutMs);
    worker.onmessage = (event) => finish(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ failed: true });
    };
    worker.postMessage({ rules, fields });
  });
}
