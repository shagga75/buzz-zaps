import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';

const sk = generateSecretKey();
const pk = getPublicKey(sk);

console.log('BUZZ_BOT_NSEC=' + nsecEncode(sk));
console.log('# pubkey (npub): ' + npubEncode(pk));
console.log('# pubkey (hex):  ' + pk);
