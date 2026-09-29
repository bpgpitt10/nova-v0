import { runAimDescriptorShotFrameProof } from '../src/liveCaddie/aimDescriptorFrameProof'

export default function handler(_request: any, response: any) {
  try {
    const passed = runAimDescriptorShotFrameProof()
    response.status(200).json({ passed, proof: 'aim-descriptor-shot-frame' })
  } catch (error) {
    response.status(500).json({
      passed: false,
      proof: 'aim-descriptor-shot-frame',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
