# How Large Language Models (LLMs) Work

**Large Language Models (LLMs)** are neural networks trained to predict the next token (word/subword) in a sequence.

---

## 1. Training

**Pre-training** is the foundation. The model is given enormous text corpora (books, websites, code, articles — often trillions of tokens) and learns one objective: given a sequence of tokens, predict the next one.

- **Self-supervised learning** — No human labels needed. The text itself provides the supervision: the "correct answer" is just the next word in the document.
- **Loss function** — Cross-entropy loss measures how far off the model's predicted probability distribution is from the actual next token. Training minimizes this loss across the entire dataset.
- **Gradient descent** — The model makes a prediction, measures the error, then propagates that error backward through every layer, nudging each weight slightly in the direction that would reduce the error. This happens billions of times.
- **Epochs and data scale** — Modern LLMs often train for only ~1 epoch (one pass over the data) because the datasets are so large. Training runs take weeks/months on thousands of GPUs and cost millions of dollars.
- **Emergent abilities** — At sufficient scale, capabilities appear that weren't explicitly trained: arithmetic, translation, code generation, chain-of-thought reasoning. These emerge from the sheer volume of patterns learned.

---

## 2. Transformer Architecture

Introduced in the 2017 paper "Attention Is All You Need." Replaced RNNs/LSTMs as the dominant architecture.

### Self-attention mechanism

- For each token in the input, the model computes three vectors: **Query (Q)**, **Key (K)**, and **Value (V)** — learned linear projections of the token's embedding.
- Attention score = how much each token should "attend to" every other token, computed as `softmax(Q · K^T / √d)`.
- The output for each token is a weighted sum of all Value vectors, where the weights are those attention scores.
- This means every token can directly access information from every other token — no sequential bottleneck.

### Multi-head attention

- Instead of one attention computation, the model runs several in parallel (e.g., 96 heads). Each head can learn different relationship types: one head might track syntax, another might track coreference, another semantic similarity.

### Layers

- Transformers stack many identical layers (e.g., 96 layers in GPT-4-class models). Each layer has:
  - Multi-head self-attention
  - Feed-forward network (two linear transformations with a nonlinearity)
  - Layer normalization and residual connections
- Lower layers tend to capture syntax/local patterns; higher layers capture semantics/abstract reasoning.

### Positional encoding

- Attention is order-agnostic by default (it's a set operation). Positional encodings are added to token embeddings so the model knows token order. Modern models use **Rotary Position Embeddings (RoPE)** which encode relative positions and enable length generalization.

### Context window

- The sequence length the model can process at once. Attention is O(n²) in sequence length, so longer contexts are expensive. Techniques like FlashAttention, sliding window attention, and sparse attention reduce this cost.

---

## 3. Tokenization

Raw text must be converted to numbers the model can process.

### Byte-Pair Encoding (BPE)

- Start with individual characters. Iteratively merge the most frequent adjacent pair into a new token. Repeat thousands of times.
- Result: common words are single tokens ("the" → `[the]`), rare words are split into subwords ("tokenization" → `["token", "ization"]`).

### Vocabulary size

- Typically 32K–100K tokens. Larger vocabularies mean fewer tokens per text (faster inference) but larger embedding matrices.

### Implications

- The model doesn't see characters or words — it sees token IDs. This is why LLMs struggle with character-level tasks (counting letters, reversing strings).
- Different languages have different tokenization efficiency. English is typically ~1 token per word; some languages need 2-3x more tokens for equivalent text.
- Code tokenization matters too: well-trained tokenizers handle common code patterns (`def`, `function`, `=>`) as single tokens.

---

## 4. Parameters

Parameters are the learned numerical weights that encode everything the model "knows."

### What they are

- Matrices of floating-point numbers. Every attention head has Q/K/V weight matrices. Every feed-forward layer has two weight matrices. Plus embedding matrices mapping tokens ↔ vectors.

### Scale

- GPT-3: 175B parameters
- LLaMA 3: 8B to 405B parameters
- Larger models generally perform better but with diminishing returns and increasing cost.

### Embeddings

- Each token in the vocabulary gets a high-dimensional vector (e.g., 4096 or 8192 dimensions). Semantically similar tokens end up near each other in this space.

### Storage

- Parameters are stored in specific precision formats:
  - **FP32** (32-bit): full precision training
  - **BF16** (16-bit): standard training precision, saves memory
  - **INT8/INT4**: quantized for inference, trading slight accuracy for major memory/speed gains
- A 70B parameter model in BF16 ≈ 140GB of weights.

### Scaling laws

- Research (Chinchilla, etc.) shows predictable relationships between parameter count, training data, compute budget, and model performance. You can forecast performance before training.

---

## 5. Inference

How the model generates text after training.

### Auto-regressive generation

1. Feed in the prompt as a sequence of tokens.
2. Model outputs a probability distribution over the entire vocabulary for the next token.
3. Sample or select a token from that distribution.
4. Append it to the sequence, repeat from step 2.

### Sampling strategies

- **Greedy** — Always pick the highest-probability token. Deterministic but often repetitive/boring.
- **Temperature** — Scale the logits before softmax. Temperature < 1 sharpens the distribution (more deterministic); > 1 flattens it (more random/creative).
- **Top-k** — Only consider the k most probable tokens, zero out the rest.
- **Top-p (nucleus sampling)** — Only consider tokens whose cumulative probability reaches p (e.g., 0.95). Adapts the number of candidates dynamically.
- **Min-p** — Only consider tokens with probability ≥ some fraction of the top token's probability.

### KV cache

- During generation, attention needs to reference all previous tokens. Rather than recomputing Q/K/V for the entire sequence each step, the model caches the K and V vectors from previous steps. This is the **KV cache** — it speeds up inference dramatically but consumes significant memory (often the bottleneck for long contexts).

### Latency considerations

- **Prefill** — Processing the entire prompt through the model (parallelizable, GPU-bound).
- **Decode** — Generating tokens one at a time (sequential, memory-bandwidth-bound).
- This is why you see a pause before output starts (prefill), then tokens stream out one by one (decode).

---

## 6. Fine-tuning and RLHF

Pre-trained models are capable but not aligned to human intent. Post-training fixes this.

### Supervised Fine-Tuning (SFT)

- Train on curated (prompt, ideal_response) pairs. The model learns to follow instructions, answer questions helpfully, format responses properly.
- Dataset quality matters enormously — a small high-quality dataset often beats a large noisy one.

### Reinforcement Learning from Human Feedback (RLHF)

1. **Reward model training** — Humans rank multiple model outputs for the same prompt. A separate model learns to predict these human preferences (a "reward model").
2. **RL optimization** — The language model is then fine-tuned using PPO (Proximal Policy Optimization) or similar to maximize the reward model's score while staying close to the SFT model (KL divergence penalty prevents collapse).

### Constitutional AI (CAI)

- Anthropic's approach. Instead of only human feedback, the model critiques and revises its own outputs based on a set of principles ("be helpful," "be harmless," "be honest"). This scales better than pure human labeling.

### RLHF alternatives

- **DPO (Direct Preference Optimization)** — Skips the reward model entirely, directly optimizing the language model on preference pairs. Simpler and increasingly popular.
- **RLAIF** — Uses AI feedback instead of (or in addition to) human feedback.

### The alignment tax

- Post-training generally makes models slightly worse at raw capability benchmarks but dramatically better at being useful, safe, and following instructions. The tradeoff is overwhelmingly worth it for real-world use.
