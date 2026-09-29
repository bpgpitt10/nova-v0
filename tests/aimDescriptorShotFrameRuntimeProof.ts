import { runAimDescriptorShotFrameProof } from '../src/liveCaddie/aimDescriptorFrameProof'

if (!runAimDescriptorShotFrameProof()) {
  throw new Error('Aim descriptor shot-frame runtime proof returned false')
}

console.log('Aim descriptor shot-frame runtime proof PASS')
