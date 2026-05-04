import styles from "./FeedItem.module.css";

interface FeedItemProps {
  timestamp: string;
  provider: string;
  model: string;
  intent: string;
  tokens: number;
  cost: string;
  status: string;
}

export function FeedItem({
  timestamp,
  provider,
  model,
  intent,
  tokens,
  cost,
  status,
}: FeedItemProps) {
  return (
    <div className={styles.item} role="row">
      <span>{timestamp}</span>
      <span>{provider}</span>
      <span>{model}</span>
      <span>{intent}</span>
      <span>{tokens.toLocaleString()}</span>
      <span>{cost}</span>
      <span>{status}</span>
    </div>
  );
}
