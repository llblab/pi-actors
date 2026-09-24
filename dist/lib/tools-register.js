/**
 * Public register_tool behavior
 * Zones: runtime tool registration, tool registry mutation, register_tool schema
 * Owns the public register_tool definition that persists local agent capabilities
 */
import * as Prompts from "./prompts.js";
import * as Registry from "./registry.js";
import * as Schema from "./schema.js";
const stringSchema = Schema.stringSchema;
const booleanSchema = Schema.booleanSchema;
const nullSchema = Schema.nullSchema;
const arraySchema = Schema.arraySchema;
const unionSchema = Schema.unionSchema;
const objectSchema = Schema.objectSchema;
const looseObjectSchema = Schema.looseObjectSchema;
export function createRegisterToolDefinition(deps) {
    return {
        name: "register_tool",
        label: "Register Tool",
        description: Prompts.REGISTER_TOOL_DESCRIPTION,
        promptSnippet: Prompts.REGISTER_TOOL_PROMPT_SNIPPET,
        promptGuidelines: Prompts.REGISTER_TOOL_GUIDELINES,
        parameters: objectSchema({
            args: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.args),
            async: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.async),
            description: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.description),
            defaults: looseObjectSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.defaults),
            draft: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.draft),
            from: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.from),
            name: stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.name),
            template: unionSchema([
                stringSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
                looseObjectSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.template),
                arraySchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateArray),
                nullSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.templateNull),
            ]),
            update: booleanSchema(Prompts.REGISTER_TOOL_PARAM_DESCRIPTIONS.update),
        }, []),
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => Registry.executeRegisterTool(params, ctx, deps),
    };
}
