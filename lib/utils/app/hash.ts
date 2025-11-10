import {createHash} from "crypto";

export default class Hasher {
    static sha256(inputString: string): string {
        return createHash('sha256').update(inputString).digest('hex');
    }
}