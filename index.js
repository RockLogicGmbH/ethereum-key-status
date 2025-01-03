require('dotenv').config();
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

const CHUNK_SIZE=parseInt(process.env.CHUNK_SIZE) || 500;
const NODE_ENDPOINT=process.env.NODE_ENDPOINT || '127.0.0.1:5052,127.0.0.1:3500,127.0.0.1:5051';
const KEY_JSON_PATH=process.env.KEY_JSON_PATH || 'keys.json';
const WEBHOOK_URL=process.env.WEBHOOK_URL || '';

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

function getAdaptiveCard(data){
    let facts = []
    Object.entries(data).forEach(([key, value]) => {
        facts.push({
            "title": key,
            "value": value
        });
      });
    return {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": {
                "type": "AdaptiveCard",
                "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                "version": "1.6",
                "body": [
                    {
                        "type": "TextBlock",
                        "text": "Lido Key Status",
                        "wrap": true,
                        "color": "Accent",
                        "isSubtle": false,
                        "weight": "Bolder",
                        "size": "Large"
                    },
                    {
                        "type": "FactSet",
                        "facts": facts
                    }
                ],
            },
        }]
    }
}

async function callWebhook(data) {
    const url = WEBHOOK_URL;
    if(!url){
        logger.error('No Webhook URL');
        return;
    }

    const options = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(getAdaptiveCard(data))
    };
    try {
        const response = await fetch(url, options);
        if(response.ok){
            const json = await response.json();
            logger.info('Webhook Response: ' + JSON.stringify(json, null, 2));
        }else{
            logger.error('Error calling webhook: ' + await response.text());
        }
    } catch (error) {
        logger.error('Error calling webhook: ' + error);
    }

}

async function checkFullnodes() {
    const fullnodes = NODE_ENDPOINT.split(',');
    const availableNodes = [];
    for (let i = 0; i < fullnodes.length; i++) {
        const node = fullnodes[i];
        const url = `http://${node}/eth/v1/node/syncing`;
        try {
            const response = await fetch(url);
            const json = await response.json();
            logger.info('Fullnode ' + node + ' is ' + (json.data.is_syncing ? `${RED}syncing${RESET}` : `${GREEN}not syncing${RESET}`) + ` (${json.data.sync_distance})`);
            if (!json.data.is_syncing) 
                availableNodes.push(node);
        } catch (error) {
            logger.error('Error connecting to Fullnode ' + node);
        }
    }
    if(availableNodes.length === 0){
        logger.error('No available Fullnodes');
        process.exit(1);
    }
    return availableNodes;
}

function getTimestamp() {
    const dateString = new Date()
        .toISOString()            // e.g., "2024-12-27T14:35:10.123Z"
        .replace(/:/g, '-')       // replace colons with dashes
        .replace('T', '_')        // optional, replace the 'T' with an underscore
        .replace(/\.\d{3}Z$/, ''); // remove milliseconds and trailing 'Z'
    return dateString;
}

async function writeResults(status) {
    const data = JSON.stringify(status, null, 2);
    const writePath = path.join(__dirname, "results",`results-${getTimestamp()}.json`);
    try {
        await fs.promises.mkdir(path.join(__dirname, "results"), { recursive: true });
        await fs.promises.writeFile(writePath, data);
        logger.info('Results written to: ' + writePath);

    } catch (error) {
        logger.error('Error writing file: ' + writePath);
    }
}

function getStatus(validators) {
    const status = {};
    validators.forEach((v) => {
        status[v.status] = status[v.status] ? status[v.status] + 1 : 1;
        if(v.status === 'active_ongoing')
            status[v.batch] = status[v.batch] ? status[v.batch] + 1 : 1;
    })
    for(let i = 0; i < validators.length; i += CHUNK_SIZE){
        status[`${i}-${i+CHUNK_SIZE}`] = status[`${i}-${i+CHUNK_SIZE}`] ? status[`${i}-${i+CHUNK_SIZE}`] : 0;
    }
    return status;
}

async function checkValidator(pubkeys, nodeEndpoint) {
    let data = [];
    for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
        const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
        const url = `http://${nodeEndpoint}/eth/v1/beacon/states/head/validators?id=${chunk.join()}`;
        const response = await fetch(url);
        const json = await response.json();
        if(json.data && Array.isArray(json.data)){
            let newData = json.data.map(d => {return {...d, batch: `${i}-${i+CHUNK_SIZE}`}});
            data = data.concat(newData);
            logger.info("Finished Batch " + i + " - " + (i + CHUNK_SIZE));
        }else{
            logger.error('Response: ' + JSON.stringify(json, null, 2));
            return [];
        }
    }
    return data;
    
}

async function readJSONFile(path) {
    try {
        const data = await fs.promises.readFile(path, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        logger.error('Error reading file: ' + path);
    }
}


async function main() {
    logger.info('Start Checking Keys');
    logger.info('Reading keys from file: ' + KEY_JSON_PATH);
    const keys = await readJSONFile(KEY_JSON_PATH);

    logger.info('Check configured Fullnodes')
    const nodeEndpoints = await checkFullnodes();

    let validatorStats = [];
    for(const nodeEndpoint of nodeEndpoints){
        logger.info('Checking ' + keys.length + ' keys on ' + nodeEndpoint);
        try{
            validatorStats = await checkValidator(keys.map(k => k.pubkey), nodeEndpoint);
        }catch(error){
            logger.error('Error checking keys on ' + nodeEndpoint);
        }
        break;
    }
    if(validatorStats.length === 0){
        logger.error('No Validator Data');
        process.exit(1);
    }

    logger.info('Getting Status of Validators');
    const status = getStatus(validatorStats);
    logger.info('Status: ' + JSON.stringify(status));

    logger.info(GREEN + 'Finished Checking Keys' + RESET);
    logger.info('Total Validators checked: ' + YELLOW + validatorStats.length + RESET);
    if(status.active_ongoing)
        logger.info('Active Validators: ' + YELLOW + status.active_ongoing + RESET);
    if(status.withdrawal_done)
        logger.info('Withdrawal Done: ' + YELLOW + status.withdrawal_done + RESET);
    if(status.withdrawal_possible)
        logger.info('Withdrawal Possible: ' + YELLOW + status.withdrawal_possible + RESET);
    await writeResults(status);
    await callWebhook(status);
}


main()