import { payments, Psbt, Transaction, TxInput } from 'bitcoinjs-lib';
import {
  Bip32Derivation,
  GlobalXpub,
  PsbtInput,
} from 'bip174/src/lib/interfaces';

type Nullable<T> = T | null;

export async function requestPayjoinWithCustomRemoteCall(
  psbt: Psbt,
  remoteCall: (psbt: Psbt) => Promise<Nullable<Psbt>>,
): Promise<void> {
  const clonedPsbt = psbt.clone();
  clonedPsbt.finalizeAllInputs();

  // We make sure we don't send unnecessary information to the receiver
  for (let index = 0; index < clonedPsbt.inputCount; index++) {
    clonedPsbt.clearFinalizedInput(index);
  }
  clonedPsbt.data.outputs.forEach((output): void => {
    delete output.bip32Derivation;
  });
  delete clonedPsbt.data.globalMap.globalXpub;

  const payjoinPsbt = await remoteCall(clonedPsbt);
  if (!payjoinPsbt) throw new Error("We did not get the receiver's PSBT");

  if (
    payjoinPsbt.data.globalMap.globalXpub &&
    (payjoinPsbt.data.globalMap.globalXpub as GlobalXpub[]).length > 0
  ) {
    throw new Error(
      "GlobalXPubs should not be included in the receiver's PSBT",
    );
  }
  if (
    hasKeypathInformationSet(payjoinPsbt.data.outputs) ||
    hasKeypathInformationSet(payjoinPsbt.data.inputs)
  ) {
    throw new Error(
      "Keypath information should not be included in the receiver's PSBT",
    );
  }

  const sanityResult = checkSanity(payjoinPsbt);
  if (Object.keys(sanityResult).length > 0) {
    throw new Error(
      `Receiver's PSBT is insane: ${JSON.stringify(sanityResult)}`,
    );
  }

  // We make sure we don't sign what should not be signed
  for (let index = 0; index < payjoinPsbt.inputCount; index++) {
    // check if input is Finalized
    if (isFinalized(payjoinPsbt.data.inputs[index]))
      payjoinPsbt.clearFinalizedInput(index);
  }

  for (let index = 0; index < payjoinPsbt.data.outputs.length; index++) {
    const output = payjoinPsbt.data.outputs[index];
    const outputLegacy = getGlobalTransaction(payjoinPsbt).outs[index];
    // Make sure only our output has any information
    delete output.bip32Derivation;
    psbt.data.outputs.forEach((originalOutput): void => {
      // update the payjoin outputs
      if (
        outputLegacy.script.equals(
          // TODO: what if output is P2SH or P2WSH or anything other than P2WPKH?
          // Can we assume output will contain redeemScript and witnessScript?
          // If so, we could decompile scriptPubkey, RS, and WS, and search for
          // the pubkey and its hash160.
          payments.p2wpkh({
            pubkey: originalOutput.bip32Derivation![0].pubkey,
          }).output!,
        )
      )
        payjoinPsbt.updateOutput(index, originalOutput);
    });
  }

  if (
    getGlobalTransaction(payjoinPsbt).version !==
    getGlobalTransaction(psbt).version
  ) {
    throw new Error('The version field of the transaction has been modified');
  }
  if (
    getGlobalTransaction(payjoinPsbt).locktime !==
    getGlobalTransaction(psbt).locktime
  ) {
    throw new Error('The LockTime field of the transaction has been modified');
  }
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

export async function requestPayjoin(
  psbt: Psbt,
  payjoinEndpoint: string,
): Promise<void> {
  return requestPayjoinWithCustomRemoteCall(
    psbt,
    (psbt1): Promise<Nullable<Psbt>> => doRequest(psbt1, payjoinEndpoint),
  );
}

function checkSanity(psbt: Psbt): { [index: number]: string[] } {
  const result: { [index: number]: string[] } = {};
  psbt.data.inputs.forEach((value, index): void => {
    const sanityResult = checkInputSanity(
      value,
      getGlobalTransaction(psbt).ins[index],
    );
    if (sanityResult.length > 0) {
      result[index] = sanityResult;
    }
  });
  return result;
}

function checkInputSanity(input: PsbtInput, txInput: TxInput): string[] {
  const errors: string[] = [];
  if (isFinalized(input)) {
    if (input.partialSig && input.partialSig.length > 0) {
      errors.push('Input finalized, but partial sigs are not empty');
    }
    if (input.bip32Derivation && input.bip32Derivation.length > 0) {
      errors.push('Input finalized, but hd keypaths are not empty');
    }
    if (input.sighashType) {
      errors.push('Input finalized, but sighash type is not null');
    }
    if (input.redeemScript) {
      errors.push('Input finalized, but redeem script is not null');
    }
    if (input.witnessScript) {
      errors.push('Input finalized, but witness script is not null');
    }
  }
  if (input.witnessUtxo && input.nonWitnessUtxo) {
    errors.push('witness utxo and non witness utxo simultaneously present');
  }

  if (input.witnessScript && !input.witnessUtxo) {
    errors.push('witness script present but no witness utxo');
  }

  if (!input.finalScriptWitness && !input.witnessUtxo) {
    errors.push('final witness script present but no witness utxo');
  }

  if (input.nonWitnessUtxo) {
    const prevTx = Transaction.fromBuffer(input.nonWitnessUtxo);
    const prevOutTxId = prevTx.getHash();
    let validOutpoint = true;

    if (!txInput.hash.equals(prevOutTxId)) {
      errors.push(
        'non_witness_utxo does not match the transaction id referenced by the global transaction sign',
      );
      validOutpoint = false;
    }
    if (txInput.index >= prevTx.outs.length) {
      errors.push(
        'Global transaction referencing an out of bound output in non_witness_utxo',
      );
      validOutpoint = false;
    }
    if (input.redeemScript && validOutpoint) {
      if (
        !redeemScriptToScriptPubkey(input.redeemScript).equals(
          prevTx.outs[txInput.index].script,
        )
      )
        errors.push(
          'The redeem_script is not coherent with the scriptPubKey of the non_witness_utxo',
        );
    }
  }

  if (input.witnessUtxo) {
    if (input.redeemScript) {
      if (
        !redeemScriptToScriptPubkey(input.redeemScript).equals(
          input.witnessUtxo.script,
        )
      )
        errors.push(
          'The redeem_script is not coherent with the scriptPubKey of the witness_utxo',
        );
      if (
        input.witnessScript &&
        input.redeemScript &&
        !input.redeemScript.equals(
          witnessScriptToScriptPubkey(input.witnessScript),
        )
      )
        errors.push(
          'witnessScript with witness UTXO does not match the redeemScript',
        );
    }
  }

  // figure out how to port this lofic
  // if (input.witnessUtxo.ScriptPubKey is  Script s)
  // {
  //
  //   if (!s.IsScriptType(ScriptType.P2SH) && !s.IsScriptType(ScriptType.Witness))
  //     errors.push('A Witness UTXO is provided for a non-witness input');
  //   if (s.IsScriptType(ScriptType.P2SH) && redeem_script is Script r && !r.IsScriptType(ScriptType.Witness))
  //   errors.push('A Witness UTXO is provided for a non-witness input');
  // }

  return errors;
}

function redeemScriptToScriptPubkey(redeemScript: Buffer): Buffer {
  return payments.p2sh({ redeem: { output: redeemScript } }).output!;
}

function witnessScriptToScriptPubkey(witnessScript: Buffer): Buffer {
  return payments.p2wsh({ redeem: { output: witnessScript } }).output!;
}

function hasKeypathInformationSet(
  items: { bip32Derivation?: Bip32Derivation[] }[],
): boolean {
  return (
    items.filter(
      (value): boolean =>
        !!value.bip32Derivation && value.bip32Derivation.length > 0,
    ).length > 0
  );
}

function isFinalized(input: PsbtInput): boolean {
  return (
    input.finalScriptSig !== undefined || input.finalScriptWitness !== undefined
  );
}

function getGlobalTransaction(psbt: Psbt): Transaction {
  // TODO: bitcoinjs-lib to expose outputs to Psbt class
  // instead of using private (JS has no private) attributes
  // @ts-ignore
  return psbt.__CACHE.__TX;
}

function doRequest(
  psbt: Psbt,
  payjoinEndpoint: string,
): Promise<Nullable<Psbt>> {
  return new Promise<Nullable<Psbt>>((resolve, reject): void => {
    if (!psbt) {
      reject();
    }

    const xhr = new XMLHttpRequest();
    xhr.onreadystatechange = (): void => {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(Psbt.fromHex(xhr.responseText));
      } else {
        reject(xhr.responseText);
      }
    };
    xhr.setRequestHeader('Content-Type', 'text/plain');
    xhr.open('POST', payjoinEndpoint);
    xhr.send(psbt.toHex());
  });
}
