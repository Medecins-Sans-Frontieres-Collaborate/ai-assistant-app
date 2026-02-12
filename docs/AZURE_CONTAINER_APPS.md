# Azure Container Apps Configuration Guide

This document outlines the required configuration for deploying this Next.js 16 application to Azure Container Apps with optimal caching, performance, and multi-instance support.

## 📋 Required Environment Variables

### Next.js Core

```bash
NODE_ENV=production
NODE_OPTIONS=--max-http-header-size=32768
GITHUB_SHA=<commit-sha>  # Set automatically in CI/CD
```

### Caching Configuration (Multi-Instance Support)

For production deployments with multiple replicas, configure Azure Blob Storage for shared caching:

```bash
# Option 1: Use connection string
AZURE_STORAGE_ACCOUNT_NAME=<your-storage-account>
AZURE_STORAGE_ACCOUNT_KEY=<your-storage-key>
CACHE_CONTAINER_NAME=nextjs-cache  # Optional, defaults to 'nextjs-cache'

# Option 2: Disable custom cache (not recommended for multi-replica)
DISABLE_CUSTOM_CACHE=true  # Falls back to filesystem cache
```

**Why This Matters:**

- Without shared cache, each container instance builds its own cache
- This causes inconsistent behavior across replicas
- Incremental Static Regeneration (ISR) won't work correctly
- Users may see different versions depending on which replica handles their request

### Authentication (NextAuth)

```bash
AUTH_SECRET=<your-secret-key>
AUTH_URL=https://your-app-url.azurecontainerapps.io
AZURE_AD_CLIENT_ID=<your-client-id>
AZURE_AD_CLIENT_SECRET=<your-client-secret>
AZURE_AD_TENANT_ID=<your-tenant-id>
```

### Application-Specific

```bash
# Add your other environment variables here
NEXT_PUBLIC_BUILD=<build-number>
NEXT_PUBLIC_ENV=production
```

## 🏗️ Azure Container Apps Configuration

### Minimum Resources

```yaml
resources:
  cpu: 0.5
  memory: 1Gi
```

### Scaling Configuration

```yaml
scale:
  minReplicas: 2 # For high availability
  maxReplicas: 10
  rules:
    - http:
        metadata:
          concurrentRequests: 50
```

### Health Probes

```yaml
probes:
  liveness:
    httpGet:
      path: /healthz
      port: 3000
    initialDelaySeconds: 30
    periodSeconds: 10
  readiness:
    httpGet:
      path: /healthz
      port: 3000
    initialDelaySeconds: 5
    periodSeconds: 5
```

## 🚀 Deployment Steps

### 1. Create Azure Blob Storage Container for Cache

```bash
# Create storage account if not exists
az storage account create \
  --name <storage-account-name> \
  --resource-group <resource-group> \
  --location <location> \
  --sku Standard_LRS

# Create container for Next.js cache
az storage container create \
  --name nextjs-cache \
  --account-name <storage-account-name> \
  --auth-mode login

# Get storage account key
az storage account keys list \
  --account-name <storage-account-name> \
  --resource-group <resource-group>
```

### 2. Configure Container App Environment Variables

```bash
az containerapp update \
  --name <app-name> \
  --resource-group <resource-group> \
  --set-env-vars \
    NODE_ENV=production \
    AZURE_STORAGE_ACCOUNT_NAME=<storage-account-name> \
    AZURE_STORAGE_ACCOUNT_KEY=<storage-key> \
    CACHE_CONTAINER_NAME=nextjs-cache
```

### 3. Deploy with CI/CD

The GitHub Actions workflow automatically:

- Builds the Docker image with Turbopack (3.7x faster)
- Caches npm dependencies and Next.js build cache
- Pushes to Azure Container Registry
- Deploys to Container App with the commit SHA as build ID

## 🔍 Monitoring Cache Performance

### Check if Blob Cache is Active

```bash
# View logs
az containerapp logs show \
  --name <app-name> \
  --resource-group <resource-group> \
  --follow

# Look for:
# ✅ "[Cache] Using Azure Blob Storage: nextjs-cache"
# ❌ "[Cache] Using filesystem cache (development mode)" - Should NOT see this in production
```

### Verify Cache Container Usage

```bash
# List cached blobs
az storage blob list \
  --container-name nextjs-cache \
  --account-name <storage-account-name> \
  --auth-mode login
```

## 📊 Performance Optimizations

### Build Performance (CI/CD)

- ✅ Next.js 16 with Turbopack: **3.7x faster builds** (39.6s → 10.7s)
- ✅ GitHub Actions cache: Caches `.next/cache` and `node_modules`
- ✅ Docker BuildKit cache: Uses GitHub Actions cache backend

### Runtime Performance

- ✅ Shared blob cache: Consistent across all replicas
- ✅ In-memory cache: 50MB (`cacheMaxMemorySize`)
- ✅ Static generation: 112 pages pre-rendered
- ✅ Image optimization: Handled by Next.js with remote patterns

### Network Performance

- ✅ HTTP/2 enabled via Container Apps
- ✅ Gzip/Brotli compression automatic
- ✅ Static assets cached with immutable headers

## 🔐 Security Best Practices

### Managed Identity (Recommended)

Instead of using storage account keys, use Azure Managed Identity:

```bash
# Enable managed identity on Container App
az containerapp identity assign \
  --name <app-name> \
  --resource-group <resource-group> \
  --system-assigned

# Grant access to storage account
az role assignment create \
  --assignee <managed-identity-principal-id> \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Storage/storageAccounts/<storage-account-name>

# Update cache-handler.js to use DefaultAzureCredential
# (Code modification needed)
```

### Network Security

- ✅ Container Apps has built-in DDoS protection
- ✅ Private networking available with VNET integration
- ✅ Azure Front Door for WAF and global load balancing

## 🐛 Troubleshooting

### Cache Not Working Across Replicas

**Symptoms:**

- Different content on page refreshes
- ISR not updating consistently
- "Stale" data appearing randomly

**Solution:**

1. Verify environment variables are set correctly
2. Check logs for cache initialization messages
3. Ensure blob container exists and has proper permissions
4. Verify storage account key is correct

### High Memory Usage

**Symptoms:**

- Container restarts frequently
- OOM (Out of Memory) errors

**Solution:**

1. Reduce `cacheMaxMemorySize` in `next.config.js`
2. Increase container memory allocation
3. Check for memory leaks in custom code
4. Use Azure Application Insights for memory profiling

### Slow Build Times

**Solution:**

1. Ensure GitHub Actions cache is working (`Restored cache` in logs)
2. Verify Docker BuildKit cache is enabled (`cache-from: type=gha`)
3. Check if Turbopack is active (should see `▲ Next.js 16.x (Turbopack)`)

## 📚 Additional Resources

- [Next.js 16 Self-Hosting Guide](https://nextjs.org/docs/app/guides/self-hosting)
- [Next.js Caching Guide](https://nextjs.org/docs/app/guides/caching)
- [Azure Container Apps Documentation](https://learn.microsoft.com/en-us/azure/container-apps/)
- [Azure Blob Storage SDK](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-quickstart-blobs-nodejs)

---

**Last Updated:** 2025-02-10
**Compatible With:** Azure Container Apps, Next.js 16.x
