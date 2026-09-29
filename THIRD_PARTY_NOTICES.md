# Third-party notices

## OpenFairway

Looper's `looper-flight-physics-v1` aerodynamic prior is a clean TypeScript adaptation of the golf-ball aerodynamic model and published coefficient profile from OpenFairway:

- Project: https://github.com/digitalhand/openfairway
- License: MIT
- Relevant upstream components reviewed: `Aerodynamics.cs`, `FlightAerodynamicsModel.cs`, `FlightProfile.cs`, `BallPhysics.cs`, and `ShotSetup.cs`.

The Looper implementation is intentionally limited to airborne flight and condition deltas. It does not embed Godot, OpenFairway ground/bounce physics, course code, or UI code. Looper adds air-relative wind handling and candidate landing-elevation intersection for its Live Caddie calibration workflow.

### MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
