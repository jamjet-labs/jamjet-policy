// Port of the Amazon Bedrock AgentCore Policy refund example.
// Source: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-conditions.html
//         https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-understanding-cedar.html
//
// AgentCore original:
//   permit(
//     principal is AgentCore::OAuthUser,
//     action == AgentCore::Action::"RefundTool___process_refund",
//     resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/refund-gateway"
//   ) when {
//     principal.hasTag("username") &&
//     principal.getTag("username") == "refund-agent" &&
//     context.input.amount < 500
//   };
//
// Mapping: AgentCore::OAuthUser -> JamJet::Agent (JWT claims become tags in both),
// the per-tool action "<Target>___<tool>" -> resource JamJet::Tool::"<Target>___<tool>"
// with the single action JamJet::Action::"call_tool", context.input unchanged.
// `context.input has amount` is added because one ToolInput type covers every tool,
// so amount is optional here.
@id("refund-under-500")
permit (
  principal is JamJet::Agent,
  action == JamJet::Action::"call_tool",
  resource == JamJet::Tool::"RefundTool___process_refund"
) when {
  principal.hasTag("username") &&
  principal.getTag("username") == "refund-agent" &&
  context.input has amount &&
  context.input.amount < 500
};
