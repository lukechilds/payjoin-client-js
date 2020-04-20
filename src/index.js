"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const bitcoinjs_lib_1 = require("bitcoinjs-lib");
const payments_1 = require("bitcoinjs-lib/types/payments");
async function requestPayjoinWithCustomRemoteCall(psbt, remoteCall) {
    const clonedPsbt = psbt.clone();
    clonedPsbt.finalizeAllInputs();
    // We make sure we don't send unnecessary information to the receiver
    for (let index = 0; index < clonedPsbt.inputCount; index++) {
        clonedPsbt.clearFinalizedInput(index);
    }
    clonedPsbt.data.outputs.forEach(output => {
        delete output.bip32Derivation;
    });
    delete clonedPsbt.data.globalMap.globalXpub;
    const payjoinPsbt = await remoteCall(clonedPsbt);
    if (!payjoinPsbt)
        return null;
    // no inputs were added?
    if (clonedPsbt.inputCount <= payjoinPsbt.inputCount) {
        return null;
    }
    // We make sure we don't sign things what should not be signed
    for (let index = 0; index < payjoinPsbt.inputCount; index++) {
        // Is Finalized
        if (payjoinPsbt.data.inputs[index].finalScriptSig !== undefined ||
            payjoinPsbt.data.inputs[index].finalScriptWitness !== undefined)
            payjoinPsbt.clearFinalizedInput(index);
    }
    for (let index = 0; index < payjoinPsbt.data.outputs.length; index++) {
        const output = payjoinPsbt.data.outputs[index];
        // TODO: bitcoinjs-lib to expose outputs to Psbt class
        // instead of using private (JS has no private) attributes
        // @ts-ignore
        const outputLegacy = payjoinPsbt.__CACHE.__TX.outs[index];
        // Make sure only the only our output have any information
        delete output.bip32Derivation;
        psbt.data.outputs.forEach(originalOutput => {
            // update the payjoin outputs
            if (outputLegacy.script.equals(
            // TODO: what if output is P2SH or P2WSH or anything other than P2WPKH?
            // Can we assume output will contain redeemScript and witnessScript?
            // If so, we could decompile scriptPubkey, RS, and WS, and search for
            // the pubkey and its hash160.
            payments_1.p2wpkh({
                pubkey: originalOutput.bip32Derivation.pubkey,
            }).output))
                payjoinPsbt.updateOutput(index, originalOutput);
        });
    }
    // TODO: check payjoinPsbt.version == psbt.version
    // TODO: check payjoinPsbt.locktime == psbt.locktime
    // TODO: check payjoinPsbt.inputs where input belongs to us, that it is not finalized
    // TODO: check payjoinPsbt.inputs where input belongs to us, that it is was included in psbt.inputs
    // TODO: check payjoinPsbt.inputs where input belongs to us, that its sequence has not changed from that of psbt.inputs
    // TODO: check payjoinPsbt.inputs where input is new, that it is finalized
    // TODO: check payjoinPsbt.inputs where input is new, that it is the same type as all other inputs from psbt.inputs (all==P2WPKH || all = P2SH-P2WPKH)
    // TODO: check psbt.inputs that payjoinPsbt.inputs contains them all
    // TODO: check payjoinPsbt.inputs > psbt.inputs
    // TODO: check that if spend amount of payjoinPsbt > spend amount of psbt:
    // TODO: * check if the difference is due to adjusting fee to increase transaction size
}
exports.requestPayjoinWithCustomRemoteCall = requestPayjoinWithCustomRemoteCall;
function requestPayjoin(psbt, payjoinEndpoint) {
    return requestPayjoinWithCustomRemoteCall(psbt, psbt1 => doRequest(psbt1, payjoinEndpoint));
}
exports.requestPayjoin = requestPayjoin;
function doRequest(psbt, payjoinEndpoint) {
    return new Promise((resolve, reject) => {
        if (!psbt) {
            reject();
        }
        const xhr = new XMLHttpRequest();
        xhr.onreadystatechange = () => {
            if (xhr.readyState !== 4)
                return;
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(bitcoinjs_lib_1.Psbt.fromHex(xhr.responseText));
            }
            else {
                reject(xhr.responseText);
            }
        };
        xhr.setRequestHeader('Content-Type', 'text/plain');
        xhr.open('POST', payjoinEndpoint);
        xhr.send(psbt.toHex());
    });
}