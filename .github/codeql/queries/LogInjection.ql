/**
 * @name Log injection (project sanitizers honoured)
 * @description Building log entries from user-controlled sources is vulnerable to
 *              insertion of forged log entries by a malicious user. This is the
 *              standard js/log-injection analysis, extended to recognise this
 *              repository's own `sanitizeForLog()` barrier.
 * @kind path-problem
 * @problem.severity error
 * @security-severity 6.1
 * @precision high
 * @id msf/log-injection
 * @tags security
 *       external/cwe/cwe-117
 */

import javascript
import semmle.javascript.security.dataflow.LogInjectionQuery as LogInjection
import LogInjection::LogInjectionFlow::PathGraph

/**
 * A call to the repository's own log sanitizers in
 * `lib/utils/server/log/logSanitization.ts`.
 *
 * `sanitizeForLog()` replaces CR/LF with spaces and strips every C0/C1
 * control character, which is exactly the CWE-117 barrier the stock query
 * looks for — it just cannot see it, because the removal happens inside a
 * chain of `String.prototype.replace` calls that taint tracking treats as
 * value-preserving. Every alert this suppressed had already been dismissed
 * by hand as a false positive (alerts 392, 407, 409, 410, …); this makes
 * that judgement executable instead of repeating it every PR.
 *
 * Matched by callee NAME rather than by import path so that re-exports and
 * test doubles behave the same. The name is distinctive enough in this
 * codebase that the looser match costs nothing; if an unrelated
 * `sanitizeForLog` ever appears, tighten this to check the callee's
 * declaration site.
 */
class ProjectLogSanitizer extends LogInjection::Sanitizer {
  ProjectLogSanitizer() {
    exists(DataFlow::CallNode call |
      call.getCalleeName() = ["sanitizeForLog", "sanitizeForLogMultiple"] and
      this = call
    )
  }
}

from LogInjection::LogInjectionFlow::PathNode source, LogInjection::LogInjectionFlow::PathNode sink
where LogInjection::LogInjectionFlow::flowPath(source, sink)
select sink.getNode(), source, sink, "This log entry depends on a $@.", source.getNode(),
  "user-provided value"
