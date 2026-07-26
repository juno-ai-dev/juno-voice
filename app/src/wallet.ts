import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';
import { BroadcastTxError, GasPrice, TimeoutError } from '@cosmjs/stargate';
import type { OfflineSigner } from '@cosmjs/proto-signing';
import { toUtf8 } from '@cosmjs/encoding';
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import type { AppConfig } from './config';
import type { ContractConfig, Request } from './types';

export interface Coin { denom: string; amount: string }
export interface SubmitInput { title: string; summary: string; acceptance_criteria: string; category: string; detail_uri: string; detail_digest: string }
export type PublicExecuteMessage = { submit_request: { title:string; summary:string; acceptance_criteria:string; category:string; detail_uri:string|null; detail_digest:string|null } } | { withdraw_refund: { request_id:number } };
export interface TransactionReview { kind:'submit'|'refund'; chainId:string; sender:string; contract:string; message:PublicExecuteMessage; funds:Coin[]; implications:string[]; fingerprint:string }
export interface TransactionReceipt { status:'confirmed'|'confirmation_pending'|'broadcast_unknown'; hash:string|null; explorerUrl:string|null; requestId:number|null; detail?:string }
export interface ExecuteResult { code:number; transactionHash:string; rawLog?:string; events?:readonly { type:string; attributes:readonly { key:string; value:string }[] }[] }
export interface SigningClient { execute(sender:string, contract:string, message:PublicExecuteMessage, fee:'auto', memo:string, funds:readonly Coin[]):Promise<ExecuteResult>; disconnect():void }

export interface WalletExtension { experimentalSuggestChain?(chain:ChainInfo):Promise<void>; enable(chainId:string):Promise<void>; getOfflineSigner(chainId:string):OfflineSigner; getChainId?():Promise<string> }
export interface ChainInfo { chainId:string; chainName:string; rpc:string; rest:string; bip44:{coinType:number}; bech32Config:Record<string,string>; currencies:readonly Currency[]; feeCurrencies:readonly Currency[]; stakeCurrency:Currency; features:readonly string[] }
interface Currency { coinDenom:string; coinMinimalDenom:string; coinDecimals:number; gasPriceStep?:{low:number;average:number;high:number} }
export interface WalletWindow extends Window { keplr?:WalletExtension; leap?:WalletExtension }
export interface LatestState { config():Promise<ContractConfig>; request(id:number):Promise<Request> }
export type SigningConnector = (rpc:string, signer:OfflineSigner)=>Promise<SigningClient>;

const utf8Length=(value:string)=>new TextEncoder().encode(value).length;
const stable=(value:unknown)=>JSON.stringify(value);
export function chainInfo(config:AppConfig):ChainInfo {
  const currency={coinDenom:'JUNOX',coinMinimalDenom:'ujunox',coinDecimals:6,gasPriceStep:{low:.025,average:.04,high:.075}};
  return {chainId:config.chainId,chainName:'Juno Testnet (uni-7)',rpc:config.rpc,rest:'https://juno-testnet-api.polkachu.com',bip44:{coinType:118},bech32Config:{bech32PrefixAccAddr:'juno',bech32PrefixAccPub:'junopub',bech32PrefixValAddr:'junovaloper',bech32PrefixValPub:'junovaloperpub',bech32PrefixConsAddr:'junovalcons',bech32PrefixConsPub:'junovalconspub'},currencies:[currency],feeCurrencies:[currency],stakeCurrency:currency,features:['cosmwasm']};
}

export class WalletConnection {
  private client:SigningClient|null=null;
  private extension:WalletExtension|null=null;
  private listeners=new Set<()=>void>();
  private browserListeners: Array<{name:string; callback:EventListener}>=[];
  private generation=0;
  constructor(private config:AppConfig,private browser:WalletWindow=window as WalletWindow,private connectSigning:SigningConnector=async(rpc,signer)=>{
    const client=await SigningCosmWasmClient.connectWithSigner(rpc,signer,{gasPrice:GasPrice.fromString('0.04ujunox')});
    return {execute:(sender,contract,message,fee,memo,funds)=>client.signAndBroadcast(sender,[{typeUrl:'/cosmwasm.wasm.v1.MsgExecuteContract',value:MsgExecuteContract.fromPartial({sender,contract,msg:toUtf8(JSON.stringify(message)),funds:[...funds]})}],fee,memo),disconnect:()=>client.disconnect()};
  }){}
  account:string|null=null;

  async connect():Promise<string>{
    const generation=++this.generation;
    this.clearConnection();
    const extension=this.browser.keplr??this.browser.leap;
    if(!extension) throw new Error('No compatible wallet found. Install or unlock Keplr or Leap.');
    let createdClient:SigningClient|null=null;
    const assertCurrent=()=>{if(this.generation!==generation)throw new Error('Wallet connection attempt was superseded.')};
    try {
      await extension.experimentalSuggestChain?.(chainInfo(this.config));
      assertCurrent();
      await extension.enable(this.config.chainId);
      assertCurrent();
      const observed=await extension.getChainId?.();
      assertCurrent();
      if(observed&&observed!==this.config.chainId) throw new Error(`Wrong chain: wallet returned ${observed}; uni-7 is required.`);
      const signer=extension.getOfflineSigner(this.config.chainId);
      const accounts=await signer.getAccounts();
      assertCurrent();
      if(accounts.length!==1||!accounts[0].address.startsWith('juno1')) throw new Error('Wallet did not provide one valid Juno account.');
      createdClient=await this.connectSigning(this.config.rpc,signer);
      assertCurrent();
      this.client=createdClient;
      this.extension=extension;
      this.account=accounts[0].address;
      this.listen();
      return this.account;
    } catch(error){
      if(createdClient&&createdClient!==this.client)createdClient.disconnect();
      // Never let cleanup from a stale attempt tear down a newer winning attempt.
      if(this.generation===generation){this.generation++;this.clearConnection()}
      throw mapTransactionError(error);
    }
  }

  private listen(){
    for(const name of ['keplr_keystorechange','leap_keystorechange','chainChanged']){
      const callback=()=>{this.disconnect();for(const listener of this.listeners)listener();};
      this.browser.addEventListener(name,callback);
      this.browserListeners.push({name,callback});
    }
  }
  private removeBrowserListeners(){
    for(const {name,callback} of this.browserListeners)this.browser.removeEventListener(name,callback);
    this.browserListeners=[];
  }
  onChange(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
  signingClient():SigningClient {if(!this.client||!this.account)throw new Error('Connect an unlocked wallet before continuing.');return this.client}
  async revalidateIdentity(chainId:string,sender:string):Promise<void>{
    if(!this.client||!this.extension||this.account!==sender)throw new Error('Wallet account changed. Review the transaction again.');
    if(!this.extension.getChainId)throw new Error('Wallet cannot revalidate its current chain. No signing request was made.');
    const observedChain=await this.extension.getChainId();
    if(observedChain!==chainId)throw new Error(`Wallet chain changed to ${observedChain}. Review the transaction again on ${chainId}.`);
    const accounts=await this.extension.getOfflineSigner(chainId).getAccounts();
    if(accounts.length!==1||accounts[0].address!==sender)throw new Error('Wallet account changed. Review the transaction again.');
    // An event may have disconnected the wallet while the extension calls were pending.
    if(!this.client||this.account!==sender)throw new Error('Wallet connection changed. Review the transaction again.');
  }
  private clearConnection(){this.removeBrowserListeners();this.client?.disconnect();this.client=null;this.extension=null;this.account=null}
  disconnect(){this.generation++;this.clearConnection()}
}

function validateText(value:string,max:number,label:string){if(!value.trim())throw new Error(`${label} is required.`);if(utf8Length(value)>max)throw new Error(`${label} exceeds the live ${max}-byte limit.`)}
export function buildSubmitReview(config:AppConfig,sender:string,live:ContractConfig,input:SubmitInput):TransactionReview {
  if(live.submissions_paused)throw new Error('Submissions are currently paused on chain.');
  if(live.native_denom!=='ujunox')throw new Error('Unsupported live bond denomination.');
  if(!/^\d+$/.test(live.submission_bond)||BigInt(live.submission_bond)<=0n)throw new Error('Invalid live submission bond.');
  const limits=live.request_limits;
  validateText(input.title,limits.max_title_bytes,'Title');validateText(input.summary,limits.max_summary_bytes,'Summary');validateText(input.acceptance_criteria,limits.max_acceptance_criteria_bytes,'Acceptance criteria');
  if(!/^[a-z0-9-]+$/.test(input.category)||utf8Length(input.category)>limits.max_category_bytes)throw new Error(`Category must use lowercase letters, digits, or hyphens within ${limits.max_category_bytes} bytes.`);
  const uri=input.detail_uri.trim(),digest=input.detail_digest.trim();
  if(Boolean(uri)!==Boolean(digest))throw new Error('Detail URI and SHA-256 digest must be provided together.');
  if(uri&&(!/^(https:\/\/|ipfs:\/\/).+/.test(uri)||utf8Length(uri)>limits.max_uri_bytes))throw new Error('Detail URI is invalid or exceeds the live byte limit.');
  if(digest&&(!/^sha256:[0-9a-f]{64}$/.test(digest)||utf8Length(digest)>limits.max_digest_bytes))throw new Error('Detail digest must be sha256: followed by 64 lowercase hex characters.');
  const message:PublicExecuteMessage={submit_request:{title:input.title,summary:input.summary,acceptance_criteria:input.acceptance_criteria,category:input.category,detail_uri:uri||null,detail_digest:digest||null}};
  const funds=[{denom:live.native_denom,amount:live.submission_bond}];
  const base={kind:'submit' as const,chainId:config.chainId,sender,contract:config.contract,message,funds,implications:['Creates a permanent public request.','The exact submission bond is locked and is refundable only if the contract later marks it refundable; spam bonds may be forfeited.']};
  return {...base,fingerprint:stable(base)};
}
export function refundEligible(request:Request,sender:string):boolean{return request.author===sender&&request.bond.state==='refundable'&&/^\d+$/.test(request.bond.amount)&&BigInt(request.bond.amount)>0n}
export function buildRefundReview(config:AppConfig,sender:string,request:Request):TransactionReview {
  if(!refundEligible(request,sender))throw new Error('Refund unavailable: only the author can withdraw a positive refundable bond.');
  const message:PublicExecuteMessage={withdraw_refund:{request_id:request.id}};
  const base={kind:'refund' as const,chainId:config.chainId,sender,contract:config.contract,message,funds:[] as Coin[],implications:[`Withdraws ${request.bond.amount} ujunox to the request author.`,'This claim is irreversible and changes the bond state to claimed.']};
  return {...base,fingerprint:stable(base)};
}
function eventRequestId(result:ExecuteResult):number|null{for(const event of result.events??[])for(const attr of event.attributes)if(attr.key==='request_id'&&/^\d+$/.test(attr.value)){const id=Number(attr.value);if(Number.isSafeInteger(id)&&id>0)return id}return null}

export class PublicTransactions {
  constructor(private config:AppConfig,private latest:LatestState,private wallet:WalletConnection,private confirmationTimeoutMs=8_000){}
  async reviewSubmit(input:SubmitInput){if(!this.wallet.account)throw new Error('Connect an unlocked wallet before continuing.');return buildSubmitReview(this.config,this.wallet.account,await this.latest.config(),input)}
  async reviewRefund(id:number){if(!this.wallet.account)throw new Error('Connect an unlocked wallet before continuing.');return buildRefundReview(this.config,this.wallet.account,await this.latest.request(id))}
  async confirm(review:TransactionReview):Promise<TransactionReceipt>{
    if(this.wallet.account!==review.sender)throw new Error('Wallet account changed. Review the transaction again.');
    let fresh:TransactionReview;
    if(review.kind==='submit'){
      if(!('submit_request'in review.message))throw new Error('Malformed reviewed submission.');
      const item=review.message.submit_request;
      fresh=buildSubmitReview(this.config,review.sender,await this.latest.config(),{...item,detail_uri:item.detail_uri??'',detail_digest:item.detail_digest??''});
    }else{
      if(!('withdraw_refund'in review.message))throw new Error('Malformed reviewed refund.');
      fresh=buildRefundReview(this.config,review.sender,await this.latest.request(review.message.withdraw_refund.request_id));
    }
    if(fresh.fingerprint!==review.fingerprint)throw new Error('On-chain state changed. Review the refreshed transaction before signing.');
    // This is deliberately the last awaited work before invoking execute. It closes delayed
    // wallet-event races by reading both chain and signer accounts directly from the extension.
    await this.wallet.revalidateIdentity(review.chainId,review.sender);
    let result:ExecuteResult;
    try{result=await this.wallet.signingClient().execute(review.sender,review.contract,review.message,'auto','Juno Voice',review.funds)}catch(error){
      if(error instanceof TimeoutError){
        const hash=error.txId;
        return {status:'confirmation_pending',hash,explorerUrl:`${this.config.explorer}/tx/${encodeURIComponent(hash)}`,requestId:null,detail:'The transaction was submitted, but CosmJS timed out waiting for inclusion. Verify this hash on chain; do not broadcast this reviewed transaction again.'};
      }
      if(isDefinitelyPrebroadcast(error)||error instanceof BroadcastTxError)throw mapTransactionError(error);
      return {status:'broadcast_unknown',hash:null,explorerUrl:null,requestId:null,detail:'The wallet or RPC stopped responding while broadcasting. The transaction may have been submitted. Verify the account on chain or in an explorer before taking any further action; do not broadcast this reviewed transaction again.'};
    }
    if(result.code!==0)throw new Error(`Transaction failed with code ${result.code}${result.rawLog?`: ${result.rawLog}`:'.'}`);
    const explorerUrl=`${this.config.explorer}/tx/${encodeURIComponent(result.transactionHash)}`;
    const requestId=review.kind==='refund'&&'withdraw_refund'in review.message?review.message.withdraw_refund.request_id:eventRequestId(result);
    const pending=(detail:string):TransactionReceipt=>({status:'confirmation_pending',hash:result.transactionHash,explorerUrl,requestId,detail});
    if(requestId===null)return pending('Broadcast was accepted, but its canonical request ID is not available yet. Do not broadcast this reviewed transaction again.');
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try {
      const delayed=new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error('canonical confirmation timed out')),this.confirmationTimeoutMs)});
      const canonical=await Promise.race([this.latest.request(requestId),delayed]);
      if(review.kind==='submit'){
        if(!('submit_request'in review.message))return pending('Broadcast was accepted, but confirmation is still pending.');
        const expected=review.message.submit_request;
        if(canonical.author!==review.sender||canonical.title!==expected.title||canonical.summary!==expected.summary||canonical.acceptance_criteria!==expected.acceptance_criteria||canonical.category!==expected.category||canonical.detail_uri!==expected.detail_uri||canonical.detail_digest!==expected.detail_digest)return pending('Broadcast was accepted; the canonical request has not converged to the reviewed submission yet. Do not broadcast again.');
      }else if(canonical.bond.state!=='claimed')return pending('Broadcast was accepted; the canonical refund state is not claimed yet. Do not broadcast again.');
    } catch(error){
      const detail=error instanceof Error?error.message:'canonical query unavailable';
      return pending(`Broadcast was accepted, but canonical confirmation is pending (${detail}). Do not broadcast again.`);
    } finally {
      if(timeout!==undefined)clearTimeout(timeout);
    }
    return {status:'confirmed',hash:result.transactionHash,explorerUrl,requestId};
  }
}
function isDefinitelyPrebroadcast(error:unknown):boolean{const message=error instanceof Error?error.message:String(error);return /reject|denied|cancel|lock|wrong chain|chain.*mismatch|unsupported chain|insufficient funds/i.test(message)}
export function mapTransactionError(error:unknown):Error{const message=error instanceof Error?error.message:String(error);if(/reject|denied|cancel/i.test(message))return new Error('Wallet request rejected. No transaction was broadcast.');if(/lock/i.test(message))return new Error('Wallet is locked. Unlock it and try again.');if(/wrong chain|chain.*mismatch|unsupported chain/i.test(message))return new Error(`Wrong chain. Switch the wallet to uni-7. (${message})`);if(/insufficient funds/i.test(message))return new Error('Insufficient funds for the bond and network fee.');if(/timeout|network|fetch|rpc|socket/i.test(message))return new Error('Network or RPC failure.');return new Error(`Transaction unavailable: ${message}`)}
