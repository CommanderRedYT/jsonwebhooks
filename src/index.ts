import fs from 'fs';
import { program } from 'commander';
import { version, description } from '../package.json';
import jp from 'jsonpath';

export interface Args {
    config: string;
}

export interface Query {
    name: string; // Name of the query
    queryUrl: string; // URL to query for the condition
    jsonQuery: string; // JSONPath query to extract the value from the response
    webhookUrl: string; // URL to send the webhook request
    webhookMethod: 'GET' | 'POST'; // HTTP method for the webhook request
    queryHeaders?: Record<string, string>; // Optional headers for the request
    invert?: boolean; // If true, the condition is inverted
    resend?: boolean; // If true, the webhook will be sent even if the condition does not change
    commonBody?: string; // Optional common body to send with the webhook request
    bodyWhenOccurs?: string; // Body to send when the condition occurs
    bodyWhenNotOccurs?: string; // Body to send when the condition does not occur anymore
    interval: number; // in milliseconds
}

export interface Config {
    queries: Query[];
}

const lastCondition: Record<string, boolean> = {};

const doFormatStrings = (str: string, replacements: Record<string, string>): string => {
    return str.replace(/\{\{(\w+)}}/g, (_, key) => {
        return replacements[key] || '';
    });
}

const handleQuery = async (query: Query): Promise<void> => {
    try {
        const response = await fetch(query.queryUrl, {
            method: 'GET',
            headers: query.queryHeaders,
        });

        if (!response.ok) {
            console.error(`Error fetching query ${query.name}: ${response.statusText}`);
            return;
        }

        const currentTime = new Date().toTimeString();

        const data = await response.json();
        const value = jp.query(data, query.jsonQuery);

        const conditionMet = value.length > 0 && !!value[0];
        const condition = query.invert ? !conditionMet : conditionMet;

        if (!(query.name in lastCondition)) {
            lastCondition[query.name] = condition;
        } else if (!query.resend && lastCondition[query.name] === condition) {
            console.log(`Condition for query ${query.name} has not changed. Skipping webhook.`);
            return;
        } else {
            console.log(`Condition for query ${query.name} has changed from ${lastCondition[query.name]} to ${condition}.`);
            lastCondition[query.name] = condition;
        }

        const body = condition ? query.bodyWhenOccurs : query.bodyWhenNotOccurs;
        const method = query.webhookMethod.toUpperCase();

        if (!body && method === 'POST') {
            console.warn(`No body defined for query ${query.name} when condition ${condition ? 'occurs' : 'does not occur'}.`);
        }

        const parsedCommonBody = query.commonBody ? JSON.parse(query.commonBody) : {};
        const bodyWhenOccurs = query.bodyWhenOccurs ? JSON.parse(query.bodyWhenOccurs) : {};
        const bodyWhenNotOccurs = query.bodyWhenNotOccurs ? JSON.parse(query.bodyWhenNotOccurs) : {};

        const actualBody = {
            ...parsedCommonBody,
            ...(condition ? bodyWhenOccurs : bodyWhenNotOccurs),
        };

        if (Object.keys(actualBody).length === 0 && method === 'POST') {
            console.warn(`No body defined for query ${query.name} when condition ${condition ? 'occurs' : 'does not occur'}.`);
        }

        const webhookResponse = await fetch(query.webhookUrl, {
            method,
            headers: {
                'Content-Type': 'application/json',
            },
            body: method === 'POST' ? doFormatStrings(JSON.stringify(actualBody), {
                currentTime,
                condition: condition ? 'true' : 'false',
                value: JSON.stringify(value),
            }) : undefined,
        });

        if (!webhookResponse.ok) {
            console.error(`Error sending webhook for query ${query.name}: ${webhookResponse.statusText}`, {
                responseBody: await webhookResponse.text(),
            });
            return;
        }

        console.log(`Webhook sent successfully for query ${query.name}. Condition: ${condition ? 'met' : 'not met'}.`);
    } catch (error) {
        console.error(`Error handling query ${query.name}:`, error);
    }
}

const main = async (args: Args): Promise<void> => {
    if (!fs.existsSync(args.config)) {
        console.error(`Configuration file not found: ${args.config}`);
        process.exit(1);
    }

    let config: unknown;
    try {
        const configContent = fs.readFileSync(args.config, 'utf-8');
        config = JSON.parse(configContent);
    } catch (error) {
        console.error(`Error reading or parsing configuration file: ${args.config}`);
        console.error(error);
        process.exit(1);
    }

    if (typeof config !== 'object' || config === null) {
        console.error(`Configuration file is not a valid JSON object.`);
        process.exit(1);
    }

    // check if config has the correct structure
    if (!('queries' in config)) {
        console.error(`Configuration file is missing the 'queries' field.`);
        process.exit(1);
    }

    const queries = (config as Config).queries;

    if (!Array.isArray(queries)) {
        console.error(`'queries' field in configuration file must be an array.`);
        process.exit(1);
    }

    if (queries.length === 0) {
        console.error(`'queries' array in configuration file cannot be empty.`);
        process.exit(1);
    }

    for (const actualQuery of queries) {
        const query = actualQuery as Query | Record<string, unknown>;
        if (typeof query !== 'object' || query === null) {
            console.error(`Each query must be a valid JSON object.`);
            process.exit(1);
        }

        // required fields
        if (typeof query.name !== 'string' || !query.name) {
            console.error(`Each query must have a valid 'name'.`);
            process.exit(1);
        }
        if (typeof query.queryUrl !== 'string' || !query.queryUrl) {
            console.error(`Each query must have a valid 'queryUrl'.`);
            process.exit(1);
        }
        if (typeof query.jsonQuery !== 'string' || !query.jsonQuery) {
            console.error(`Each query must have a valid 'jsonQuery'.`);
            process.exit(1);
        }
        if (typeof query.webhookUrl !== 'string' || !query.webhookUrl) {
            console.error(`Each query must have a valid 'webhookUrl'.`);
            process.exit(1);
        }
        if (typeof query.webhookMethod !== 'string' || !['GET', 'POST'].includes(query.webhookMethod)) {
            console.error(`Each query must have a valid 'webhookMethod' ('GET' or 'POST').`);
            process.exit(1);
        }
        if (typeof query.interval !== 'number' || query.interval <= 0) {
            console.error(`Each query must have a valid 'interval' greater than 0.`);
            process.exit(1);
        }

        // optional fields
        if (typeof query.queryHeaders !== 'undefined' && typeof query.queryHeaders !== 'object') {
            console.error(`'queryHeaders' must be an object if provided.`);
            process.exit(1);
        }

        if (typeof query.invert !== 'undefined' && typeof query.invert !== 'boolean') {
            console.error(`'invert' must be a boolean if provided.`);
            process.exit(1);
        }

        if (typeof query.resend !== 'undefined' && typeof query.resend !== 'boolean') {
            console.error(`'resend' must be a boolean if provided.`);
            process.exit(1);
        }

        if (typeof query.commonBody !== 'undefined' && typeof query.commonBody !== 'string') {
            console.error(`'commonBody' must be a string if provided.`);
            process.exit(1);
        }

        if (typeof query.bodyWhenOccurs !== 'undefined' && typeof query.bodyWhenOccurs !== 'string') {
            console.error(`'bodyWhenOccurs' must be a string if provided.`);
            process.exit(1);
        }

        if (typeof query.bodyWhenNotOccurs !== 'undefined' && typeof query.bodyWhenNotOccurs !== 'string') {
            console.error(`'bodyWhenNotOccurs' must be a string if provided.`);
            process.exit(1);
        }
    }

    console.log('Configuration is valid. Starting the application...');

    for (const query of queries) {
        setInterval(async () => handleQuery(query), query.interval);
        handleQuery(query).catch((error) => {
            console.error(`Error processing first query ${query.name}:`, error);
        });
    }
};

program
    .version(version)
    .description(description)
    .option('-c, --config <path>', 'Path to the configuration file', 'config.json')
    .action((options) => {
        const args: Args = {
            config: options.config,
        };

        main(args).catch((error) => {
            console.error('An error occurred:', error);
            process.exit(1);
        });
    });

program.parse(process.argv);
