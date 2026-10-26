import forestRestIllustration from '../assets/pinekin-forest-panorama.png'

export function ConversationEnd() {
  return <div className="conversation-ending">
    <img className="conversation-end-illustration" src={forestRestIllustration} alt="" aria-hidden="true"
      width={1600} height={640} draggable={false} loading="lazy" decoding="async" />
  </div>
}
