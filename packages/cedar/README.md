# @jamjet/cedar

Cedar policies for JamJet. If your team already writes Cedar for Amazon Bedrock
AgentCore Policy or the Microsoft Agent Governance Toolkit, you can enforce the same
policies on tool calls governed by JamJet, alongside your existing `policy.yaml`.

## Schema

Every policy is validated in strict mode against the published schema in
[`schema/jamjet.cedarschema`](schema/jamjet.cedarschema):

| Cedar | JamJet meaning |
| --- | --- |
| `principal` `JamJet::Agent::"<id>"` | the calling agent or user. Attributes `kind`, `run_id`. String tags carry identity claims (`principal.getTag("username")`). |
| `action` `JamJet::Action::"call_tool"` | one tool call |
| `resource` `JamJet::Tool::"<server>___<tool>"` | the tool, a member of `JamJet::Server::"<server>"`. Attributes `name`, `server`. |
| `context.input` | the tool arguments, typed by your `JamJet::Input::ToolInput` |
| `context.args_digest` | sha256 of the canonical JSON arguments (same digest as the receipt) |
| `context.risk` | risk label supplied by the enforcement point, `"unknown"` if absent |
| `context.approval_status` | hold state for this exact call: `none`, `pending`, `approved`, `rejected` |

Tool arguments are invisible to policies until you type them. Write a schema fragment
with only common types in the `JamJet::Input` namespace:

```cedar
namespace JamJet::Input {
  type ToolInput = { orderId?: String, amount?: Long, reason?: String };
}
```

Arguments may use `String`, `Long`, `Bool`, sets and records. Arguments the schema does
not declare are dropped before evaluation (strict validation means no policy can read
them), so `context.input has x` on an undeclared `x` is a load error rather than a
test that is always false. A declared argument with the wrong type, or an integer
beyond 2^53 (JavaScript cannot hold it exactly), blocks the call.

## Decisions

- No satisfied permit: **block** (Cedar default deny).
- A satisfied `forbid`: **block**.
- A satisfied `permit`: **allow**.
- A satisfied `permit` annotated `@require_approval`: **require_approval** (JamJet holds the call for a human). If any satisfied permit carries the annotation, the call is held.
- Any evaluation error, request validation error, or internal failure: **block**. Cedar on its own skips a policy that errors, which would let an erroring `forbid` fall away; JamJet does not.

```cedar
@id("approve-large-refunds")
@require_approval
permit (principal, action == JamJet::Action::"call_tool", resource == JamJet::Tool::"RefundTool___process_refund")
when { context.input has amount && context.input.amount >= 500 };
```

Loading fails (and nothing is enforced) on a parse error, a schema error, any
validation error or warning, a template, a duplicate `@id`, `@require_approval` on a
`forbid`, or any other annotation that mentions approval (so `@requires_approval`
cannot quietly load as a plain permit).

## With YAML rules

Both engines run on every call and the stricter outcome wins:
`block` > `require_approval` > `audit` > `allow`. Neither can loosen the other. Loading
Cedar makes the combined policy default deny, because Cedar denies anything no permit
covers.

## API

```ts
import { loadCedarPoliciesFromFiles, combineDecisions } from '@jamjet/cedar'

const cedar = loadCedarPoliciesFromFiles('./policies.cedar', './input.cedarschema')
const decision = combineDecisions(yamlEvaluator.evaluate(tool), cedar.evaluate({
  server: 'RefundTool',
  tool: 'process_refund',
  args: { orderId: '12345', amount: 450 },
  principal: { id: 'user-123', tags: { username: 'refund-agent' } },
}))
```

`@jamjet/ext-authz` (`--cedar`) and `jamjet policy validate|explain` in `@jamjet/cli` use this package.

Uses [`@cedar-policy/cedar-wasm`](https://www.npmjs.com/package/@cedar-policy/cedar-wasm) (Apache-2.0), Node build.
