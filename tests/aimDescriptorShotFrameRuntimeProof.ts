import { runAimDescriptorShotFrameProof } from '../src/liveCaddie/aimDescriptorFrameProof'

// Keep this entrypoint tiny: the scenarios live beside the descriptor implementation.
if (!runAimDescriptorShotFrameProof()) {
  throw new Error('Aim descriptor shot-frame runtime proof returned false')
}

console.log('Aim descriptor shot-frame runtime proof PASS')
