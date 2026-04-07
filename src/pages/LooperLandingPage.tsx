import looperRef from '../assets/looper-landing-ref.png'

export default function LooperLandingPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#08120d',
        padding: '2vh 2vw',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: 'min(1200px, 96vw)',
        }}
      >
        <img
          src={looperRef}
          alt=""
          aria-hidden="true"
          style={{
            display: 'block',
            width: '100%',
            height: 'auto',
            maxHeight: '96vh',
            margin: '0 auto',
            objectFit: 'contain',
          }}
        />

        <button
          type="button"
          aria-label="Choose Club"
          title="Choose Club"
          style={{ position: 'absolute', left: '12.2%', top: '73.4%', width: '30.8%', height: '6.9%', background: 'transparent', border: 'none', padding: 0, opacity: 0.01, cursor: 'pointer' }}
          onClick={() => console.log('Choose Club clicked')}
        />

        <button
          type="button"
          aria-label="Start"
          title="Start"
          style={{ position: 'absolute', left: '12.2%', top: '81.1%', width: '30.8%', height: '6.9%', background: 'transparent', border: 'none', padding: 0, opacity: 0.01, cursor: 'pointer' }}
          onClick={() => console.log('Start clicked')}
        />

        <button
          type="button"
          aria-label="Open Data"
          title="Open Data"
          style={{ position: 'absolute', left: '56.8%', top: '77.2%', width: '30.8%', height: '6.9%', background: 'transparent', border: 'none', padding: 0, opacity: 0.01, cursor: 'pointer' }}
          onClick={() => console.log('Open Data clicked')}
        />
      </div>
    </div>
  )
}
